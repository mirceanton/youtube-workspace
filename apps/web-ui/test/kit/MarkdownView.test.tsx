import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "../../src/kit/MarkdownView.tsx";
import { isExternalHref, sanitizeHref } from "../../src/lib/safe-url.ts";
import { expectNoA11yViolations } from "../helpers/a11y.ts";
import { XSS_CORPUS } from "../fixtures/xss-corpus.ts";

const FORBIDDEN_TAGS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "style",
  "form",
  "svg",
  "math",
  "img",
  "picture",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "template",
  "noscript",
  "button",
  "select",
  "textarea",
  "dialog",
];
const SAFE_SCHEMES = /^(https?:|mailto:|#)/;

async function renderMarkdown(
  markdown: string,
  props: { headingStart?: 1 | 2 | 3 | 4 | 5 | 6 } = {},
) {
  const view = render(<MarkdownView markdown={markdown} {...props} />);
  // The renderer is lazy: wait until the plain-text fallback has been replaced.
  await waitFor(() => expect(view.container.querySelector("[data-markdown-loading]")).toBeNull());
  return view;
}

/** Nothing in the rendered DOM may be live: no script-capable element, handler, style or unsafe URL. */
function expectInert(root: Element): void {
  for (const tag of FORBIDDEN_TAGS) {
    expect(root.querySelector(tag), `<${tag}> must not be rendered`).toBeNull();
  }
  for (const element of root.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      expect(attribute.name.startsWith("on"), `${element.tagName} has ${attribute.name}`).toBe(
        false,
      );
      expect([
        "style",
        "srcdoc",
        "src",
        "action",
        "formaction",
        "xlink:href",
        "data",
        "background",
      ]).not.toContain(attribute.name);
    }
    if (element.tagName === "INPUT") {
      expect(element.getAttribute("type")).toBe("checkbox");
      expect(element.hasAttribute("disabled")).toBe(true);
    }
  }
  for (const anchor of root.querySelectorAll("a")) {
    const href = anchor.getAttribute("href");
    if (href === null) continue;
    expect(href, `unsafe href ${href}`).toMatch(SAFE_SCHEMES);
    if (href.startsWith("http")) {
      expect(anchor.getAttribute("target")).toBe("_blank");
      const rel = anchor.getAttribute("rel") ?? "";
      expect(rel).toContain("noopener");
      expect(rel).toContain("noreferrer");
    }
    expect(
      anchor.attributes.length,
      "anchors carry only href, target, rel and title",
    ).toBeLessThanOrEqual(4);
  }
}

describe("MarkdownView: XSS payload corpus", () => {
  it("has a meaningful corpus", () => {
    expect(XSS_CORPUS.length).toBeGreaterThanOrEqual(60);
    expect(new Set(XSS_CORPUS.map((p) => p.name)).size).toBe(XSS_CORPUS.length);
  });

  it.each(XSS_CORPUS.map((p) => [p.name, p.markdown] as const))(
    "%s renders inert",
    async (_name, markdown) => {
      const { container } = await renderMarkdown(markdown);
      expectInert(container);
    },
  );

  it("shows raw HTML as literal text instead of parsing it", async () => {
    const { container } = await renderMarkdown("<script>alert(1)</script> and <b>bold</b>");
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain("<b>bold</b>");
    expect(container.querySelector("b")).toBeNull();
  });

  it("drops dangerous link targets but keeps the link text readable", async () => {
    const { container } = await renderMarkdown("[click me](javascript:alert(1))");
    expect(screen.getByText("click me")).toBeInTheDocument();
    expect(container.querySelector("a")).toBeNull();
  });

  it("never loads images: they become a link to the address", async () => {
    const { container } = await renderMarkdown("![diagram](https://example.com/a.png)");
    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: /Image: diagram/ });
    expect(link).toHaveAttribute("href", "https://example.com/a.png");
  });

  it("does not execute anything (no global side effects while rendering hostile input)", async () => {
    const calls: unknown[] = [];
    (window as unknown as { alert: (v: unknown) => void }).alert = (v) => calls.push(v);
    for (const payload of XSS_CORPUS) {
      const { unmount } = await renderMarkdown(payload.markdown);
      unmount();
    }
    expect(calls).toEqual([]);
  });
});

describe("MarkdownView: rendering", () => {
  it("renders GitHub-flavoured markdown", async () => {
    const { container } = await renderMarkdown(
      "## Title\n\nSome **bold**, _italic_ and ~~struck~~ text with `code`.\n\n- [x] done\n- [ ] todo\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```\nblock\n```",
    );
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector("del")?.textContent).toBe("struck");
    expect(container.querySelectorAll("input[type=checkbox]")).toHaveLength(2);
    expect(container.querySelector(".markdown-table-scroll table")).not.toBeNull();
    expect(container.querySelector("pre code")?.textContent).toContain("block");
    expectInert(container);
  });

  it("re-levels headings below the page's own: the shallowest becomes h3, the rest follow", async () => {
    await renderMarkdown("# One\n\n## Two\n\n### Three");
    expect(screen.getByRole("heading", { level: 3, name: "One" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Two" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 5, name: "Three" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("does not skip a level when the document starts at h2 or jumps ahead", async () => {
    await renderMarkdown("## Starts at two\n\n###### Jumps to six\n\n## Back to two");
    expect(screen.getByRole("heading", { level: 3, name: "Starts at two" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Jumps to six" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Back to two" })).toBeInTheDocument();
  });

  it("honours headingStart and never goes below h6", async () => {
    await renderMarkdown("# One\n\n## Two\n\n### Three", { headingStart: 5 });
    expect(screen.getByRole("heading", { level: 5, name: "One" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 6, name: "Two" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 6, name: "Three" })).toBeInTheDocument();
  });

  it("opens external links in a new tab without opener or referrer", async () => {
    await renderMarkdown("[docs](https://example.com/docs?a=1)");
    const link = screen.getByRole("link", { name: /docs/ });
    expect(link).toHaveAttribute("href", "https://example.com/docs?a=1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow ugc");
    expect(link).toHaveAccessibleName(/opens in a new tab/);
  });

  it("keeps mailto links and same-page fragments in the page", async () => {
    await renderMarkdown("[mail](mailto:a@example.com) [top](#intro)");
    expect(screen.getByRole("link", { name: "mail" })).not.toHaveAttribute("target");
    expect(screen.getByRole("link", { name: "top" })).toHaveAttribute("href", "#intro");
  });

  it("renders an empty document without error and passes an accessibility audit", async () => {
    const { container } = await renderMarkdown("");
    expect(container.querySelector(".markdown")).not.toBeNull();
    await expectNoA11yViolations(container);
  });

  it("has no accessibility violations on a rich document", async () => {
    const { container } = await renderMarkdown(
      "## Plan\n\n1. First\n2. Second\n\n> quote\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[link](https://example.com)",
    );
    await expectNoA11yViolations(container);
  });
});

describe("sanitizeHref", () => {
  it.each([
    ["https://example.com/a?b=1#c", "https://example.com/a?b=1#c"],
    ["http://example.com", "http://example.com/"],
    ["  https://example.com  ", "https://example.com/"],
    ["mailto:me@example.com", "mailto:me@example.com"],
    ["#section-1", "#section-1"],
  ])("accepts %s", (input, expected) => {
    expect(sanitizeHref(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:x",
    "file:///etc/passwd",
    "blob:https://example.com/x",
    "//example.com",
    "/relative",
    "relative",
    "https://user:pw@example.com/",
    "https://trusted.example@evil.example/",
    "#bad fragment",
    "ftp://example.com/",
    "tel:+1",
  ])("rejects %j", (input) => {
    expect(sanitizeHref(input)).toBeNull();
  });

  it("treats only http(s) as external", () => {
    expect(isExternalHref("https://example.com/")).toBe(true);
    expect(isExternalHref("#x")).toBe(false);
    expect(isExternalHref("mailto:a@b.c")).toBe(false);
  });
});
