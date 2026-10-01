import { describe, expect, it } from "vitest";
import { scriptFileName, slugify } from "../src/index.js";
import { IDEA_ID, catchScriptMdError, seededRandom } from "./helpers.js";

const SAFE_NAME = /^[a-z0-9][a-z0-9.-]*\.md$/;

describe("scriptFileName", () => {
  it("builds title-kind-version.md", () => {
    expect(
      scriptFileName({ ideaId: IDEA_ID, kind: "script", version: 3, title: "Why Rust Is Fast" }),
    ).toBe("why-rust-is-fast-script-v3.md");
    expect(scriptFileName({ ideaId: IDEA_ID, kind: "packaging", version: 12, title: "Rust" })).toBe(
      "rust-packaging-v12.md",
    );
  });

  it("omits the version when none is given", () => {
    expect(scriptFileName({ ideaId: IDEA_ID, kind: "script", title: "Rust" })).toBe(
      "rust-script.md",
    );
  });

  it("falls back to the start of the idea id without a usable title", () => {
    for (const title of [undefined, "", "   ", "\u{1F600}\u{1F680}", "!!!", "\u65E5\u672C\u8A9E"]) {
      expect(scriptFileName({ ideaId: IDEA_ID, kind: "script", version: 1, title })).toBe(
        "idea-0190f3a2-script-v1.md",
      );
    }
    expect(scriptFileName({ ideaId: IDEA_ID.toUpperCase(), kind: "script", version: 1 })).toBe(
      "idea-0190f3a2-script-v1.md",
    );
  });

  it("folds accents and collapses punctuation", () => {
    expect(slugify("Caf\u00E9 -- r\u00E9sum\u00E9: 10 tips!")).toBe("cafe-resume-10-tips");
    expect(slugify("  --A  B--  ")).toBe("a-b");
    expect(slugify("\uFF21\uFF22\uFF23")).toBe("abc"); // full-width letters fold to ASCII
  });

  it("limits the slug length and never ends on a hyphen", () => {
    const slug = slugify("word ".repeat(100));
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
    expect(slugify("a".repeat(100_000)).length).toBe(48);
  });

  it("neutralizes path traversal, separators, header injection and bidi tricks", () => {
    const hostile = [
      "../../etc/passwd",
      "..\\..\\windows\\system32",
      'x"; filename="evil.exe',
      "line\r\nSet-Cookie: a=b",
      "name\u0000.md",
      "\u202Efdp.exe",
      "CON",
      "a/b\\c:d*e?f<g>h|i",
      ".hidden",
      "~/secret",
    ];
    const names = hostile.map((title) =>
      scriptFileName({ ideaId: IDEA_ID, kind: "script", version: 1, title }),
    );
    expect(names.filter((name) => !SAFE_NAME.test(name) || name.includes(".."))).toEqual([]);
    expect(names).toContain("hidden-script-v1.md");
    expect(names).toContain("con-script-v1.md");
  });

  it("always produces a safe name for random titles", () => {
    const random = seededRandom(99);
    for (let i = 0; i < 500; i++) {
      let title = "";
      const length = Math.floor(random() * 80);
      for (let j = 0; j < length; j++)
        title += String.fromCodePoint(Math.floor(random() * 0x2fff) + 1);
      expect(scriptFileName({ ideaId: IDEA_ID, kind: "packaging", version: i, title })).toMatch(
        SAFE_NAME,
      );
    }
  });

  it("rejects invalid parts", () => {
    expect.hasAssertions();
    catchScriptMdError(
      () => scriptFileName({ ideaId: "nope", kind: "script" }),
      "invalid_argument",
    );
    catchScriptMdError(
      () => scriptFileName({ ideaId: IDEA_ID, kind: "x" as never }),
      "invalid_argument",
    );
    catchScriptMdError(
      () => scriptFileName({ ideaId: IDEA_ID, kind: "script", version: -2 }),
      "invalid_argument",
    );
  });
});
