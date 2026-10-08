import { describe, expect, it } from "vitest";
import { scriptFileName, slugify } from "../src/index.js";
import { IDEA_ID, catchScriptMdError } from "./helpers.js";

describe("scriptFileName", () => {
  it("builds title-kind-version.md and omits the version when none is given", () => {
    const parts = { ideaId: IDEA_ID, kind: "script", title: "Why Rust Is Fast" } as const;
    expect(scriptFileName({ ...parts, version: 3 })).toBe("why-rust-is-fast-script-v3.md");
    expect(scriptFileName({ ...parts, kind: "packaging" })).toBe("why-rust-is-fast-packaging.md");
  });

  it("falls back to the start of the idea id without a usable title", () => {
    for (const title of [undefined, "", "\u{1F600}\u{1F680}", "日本語"]) {
      expect(scriptFileName({ ideaId: IDEA_ID, kind: "script", version: 1, title })).toBe(
        "idea-0190f3a2-script-v1.md",
      );
    }
  });

  it("folds accents, collapses punctuation and limits the slug length", () => {
    expect(slugify("Café -- résumé: 10 tips!")).toBe("cafe-resume-10-tips");
    expect(slugify("a".repeat(47) + " b")).toHaveLength(47); // cut at 48, no trailing hyphen
  });

  it("neutralizes path traversal, header injection and bidi tricks", () => {
    const hostile = ["../../etc/passwd", 'x"; filename="evil.exe', "a\r\nSet-Cookie: b", "‮fdp"];
    for (const title of hostile) {
      const name = scriptFileName({ ideaId: IDEA_ID, kind: "script", version: 1, title });
      expect(name).toMatch(/^[a-z0-9][a-z0-9.-]*\.md$/);
      expect(name).not.toContain("..");
    }
  });

  it("rejects invalid parts", () => {
    expect.hasAssertions();
    catchScriptMdError(
      () => scriptFileName({ ideaId: "nope", kind: "script" }),
      "invalid_argument",
    );
    catchScriptMdError(
      () => scriptFileName({ ideaId: IDEA_ID, kind: "script", version: -2 }),
      "invalid_argument",
    );
  });
});
