import { SCRIPT_KINDS, SCRIPT_STATUSES } from "@ytw/shared";
import { describe, expect, it } from "vitest";
import {
  parseCompleteScriptFile,
  parseScriptFile,
  serializeScriptFile,
  type ScriptFile,
} from "../src/index.js";
import { IDEA_ID, catchScriptMdError, exportedFile, seededRandom } from "./helpers.js";

const base: ScriptFile = {
  ideaId: IDEA_ID,
  kind: "script",
  version: 3,
  status: "draft",
  body: "# Hook\n\nHello world.\n",
};

describe("serializeScriptFile", () => {
  it("writes the canonical layout: fixed key order, blank line, body", () => {
    expect(serializeScriptFile(base)).toBe(
      [
        "---",
        `idea_id: ${IDEA_ID}`,
        "kind: script",
        "version: 3",
        "status: draft",
        "---",
        "",
        "# Hook",
        "",
        "Hello world.",
        "",
      ].join("\n"),
    );
  });

  it("ends right after the closing fence when the body is empty", () => {
    expect(serializeScriptFile({ ...base, body: "" })).toBe(
      `---\nidea_id: ${IDEA_ID}\nkind: script\nversion: 3\nstatus: draft\n---\n`,
    );
  });

  it("lowercases the idea id", () => {
    const text = serializeScriptFile({ ...base, ideaId: IDEA_ID.toUpperCase() });
    expect(text).toContain(`idea_id: ${IDEA_ID}\n`);
  });

  it("always writes LF and never a byte order mark", () => {
    const text = serializeScriptFile({ ...base, body: "a\r\nb\rc\n" });
    expect(text).not.toContain("\r");
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.endsWith("\n\na\nb\nc\n")).toBe(true);
  });

  it("keeps the body exactly otherwise: leading and trailing blank lines, no trailing newline", () => {
    for (const body of [
      "\n\nlead",
      "trail\n\n\n",
      "no newline at end",
      "  indented\n\ttab",
      "---\nhr",
    ]) {
      const text = serializeScriptFile({ ...base, body });
      expect(text.endsWith(body)).toBe(true);
    }
  });

  it("accepts version 0 (the base of a first revision) and the largest integer version", () => {
    expect(serializeScriptFile({ ...base, version: 0 })).toContain("version: 0\n");
    expect(serializeScriptFile({ ...base, version: 2_147_483_647 })).toContain(
      "version: 2147483647\n",
    );
  });

  it.each([
    ["idea id not a uuid", { ideaId: "not-a-uuid" }],
    ["idea id with an injected line", { ideaId: `${IDEA_ID}\nstatus: approved` }],
    ["unknown kind", { kind: "outline" as never }],
    ["unknown status", { status: "published" as never }],
    ["status with an injected line", { status: "draft\nversion: 9" as never }],
    ["negative version", { version: -1 }],
    ["fractional version", { version: 1.5 }],
    ["version above the integer range", { version: 2_147_483_648 }],
    ["NaN version", { version: Number.NaN }],
    ["string version", { version: "3" as never }],
    ["non-string body", { body: 42 as never }],
  ])("rejects %s with invalid_argument", (_name, patch) => {
    expect.hasAssertions();
    catchScriptMdError(() => serializeScriptFile({ ...base, ...patch }), "invalid_argument");
  });

  it("rejects a body with a NUL character", () => {
    expect.hasAssertions();
    catchScriptMdError(
      () => serializeScriptFile({ ...base, body: "a\u0000b" }),
      "invalid_characters",
    );
  });
});

describe("parseCompleteScriptFile", () => {
  it("reads every field of an exported file", () => {
    expect(parseCompleteScriptFile(exportedFile())).toEqual({
      ideaId: IDEA_ID,
      kind: "script",
      version: 3,
      status: "draft",
      body: "# Hook\n\nHello.\n",
    });
  });

  it("requires front matter", () => {
    const error = catchScriptMdError(
      () => parseCompleteScriptFile("# just a body\n"),
      "front_matter_invalid",
    );
    expect(error.message).toContain("no front matter");
  });

  it("names the missing fields", () => {
    const error = catchScriptMdError(
      () => parseCompleteScriptFile(`---\nidea_id: ${IDEA_ID}\nkind: script\n---\nbody`),
      "front_matter_invalid",
    );
    expect(error.message).toContain("version, status");
    expect(error.details["missing"]).toEqual(["version", "status"]);
  });
});

describe("round trip", () => {
  it("parse(serialize(x)) returns x for every kind and status", () => {
    for (const kind of SCRIPT_KINDS) {
      for (const status of SCRIPT_STATUSES) {
        const file: ScriptFile = { ...base, kind, status, version: 12 };
        expect(parseCompleteScriptFile(serializeScriptFile(file))).toEqual(file);
      }
    }
  });

  it("serialize(parse(file)) returns a canonical file unchanged", () => {
    const file = exportedFile({ body: "line one\n\nline two\n" });
    expect(serializeScriptFile(parseCompleteScriptFile(file))).toBe(file);
  });

  it("is stable when applied twice", () => {
    const once = serializeScriptFile({ ...base, body: "a\r\nb" });
    const twice = serializeScriptFile(parseCompleteScriptFile(once));
    expect(twice).toBe(once);
  });

  it("preserves awkward bodies: fences, blank edges, unicode, a BOM character inside", () => {
    const bodies = [
      "",
      "\n",
      "\n\n",
      "---",
      "---\n",
      "---\nnot: front matter\n---\nstill body",
      "\n---\nafter blank",
      "text\n---\nmore text\n",
      "...\n",
      "# Title\n\n- a\n- b\n",
      "emoji \u{1F600} and accents \u00E9\u0301 and CJK \u65E5\u672C\u8A9E\n",
      "\uFEFFa BOM in the body is content, not a marker",
      "  \n \t\n",
      "trailing spaces   \nnext",
    ];
    const changed = bodies.filter(
      (body) => parseCompleteScriptFile(serializeScriptFile({ ...base, body })).body !== body,
    );
    expect(changed).toEqual([]);
  });

  it("round-trips 2000 random bodies built from fence-like fragments", () => {
    const random = seededRandom(0x5eed);
    const pieces = [
      "---",
      "\n",
      "\n",
      "\r\n",
      "\r",
      " ",
      "\t",
      "a",
      "word ",
      "# h",
      "...",
      "\u00E9",
      "\u{1F600}",
      ":",
      "- ",
    ];
    const failures: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const length = Math.floor(random() * 24);
      let body = "";
      for (let j = 0; j < length; j++) body += pieces[Math.floor(random() * pieces.length)];
      const parsed = parseCompleteScriptFile(serializeScriptFile({ ...base, body }));
      if (parsed.body !== body.replace(/\r\n?/g, "\n") || parsed.version !== 3) {
        failures.push(JSON.stringify(body));
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("newline and BOM handling", () => {
  const lf = exportedFile({ body: "one\n\ntwo\n" });

  it("reads a CRLF file (front matter and body) as LF", () => {
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(parseCompleteScriptFile(crlf)).toEqual(parseCompleteScriptFile(lf));
  });

  it("reads a file with lone CR line endings as LF", () => {
    const cr = lf.replace(/\n/g, "\r");
    expect(parseCompleteScriptFile(cr)).toEqual(parseCompleteScriptFile(lf));
  });

  it("reads mixed line endings", () => {
    const mixed = `---\r\nidea_id: ${IDEA_ID}\nkind: script\r\nversion: 3\nstatus: draft\r\n---\r\n\nline\r\nline\nline\r`;
    expect(parseCompleteScriptFile(mixed).body).toBe("line\nline\nline\n");
  });

  it("strips one leading BOM, in text and in bytes", () => {
    const withBom = `\uFEFF${lf}`;
    expect(parseCompleteScriptFile(withBom)).toEqual(parseCompleteScriptFile(lf));
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(lf)]);
    expect(parseCompleteScriptFile(bytes)).toEqual(parseCompleteScriptFile(lf));
  });

  it("strips a BOM from a file without front matter", () => {
    expect(parseScriptFile("\uFEFF# Title\n")).toEqual({
      hasFrontMatter: false,
      frontMatter: {},
      body: "# Title\n",
    });
  });

  it("strips only one BOM", () => {
    expect(parseScriptFile("\uFEFF\uFEFFtext").body).toBe("\uFEFFtext");
  });

  it("reads UTF-8 bytes the same as the equivalent string", () => {
    const text = exportedFile({ body: "caf\u00E9 \u{1F600}\n" });
    expect(parseCompleteScriptFile(new TextEncoder().encode(text))).toEqual(
      parseCompleteScriptFile(text),
    );
  });
});

describe("front matter syntax accepted from hand-edited files", () => {
  it("accepts quoted values, comments, extra keys, any key order and trailing fence spaces", () => {
    const text = [
      "---   ",
      "# exported by an agent",
      "status: 'review'   # keep",
      'version: "7"',
      `kind: "packaging"`,
      "title: Why Rust is fast",
      "tags: [rust, performance]",
      `idea_id: ${IDEA_ID.toUpperCase()}`,
      "---  ",
      "body",
    ].join("\n");
    expect(parseCompleteScriptFile(text)).toEqual({
      ideaId: IDEA_ID,
      kind: "packaging",
      version: 7,
      status: "review",
      body: "body",
    });
  });

  it("accepts the body directly after the closing fence, without a blank line", () => {
    const text = `---\nidea_id: ${IDEA_ID}\nkind: script\nversion: 1\nstatus: draft\n---\n# Directly\n`;
    expect(parseCompleteScriptFile(text).body).toBe("# Directly\n");
  });

  it("drops exactly one separator blank line", () => {
    const text = `---\nidea_id: ${IDEA_ID}\nkind: script\nversion: 1\nstatus: draft\n---\n\n\nbody`;
    expect(parseCompleteScriptFile(text).body).toBe("\nbody");
  });

  it("accepts a closing fence at the very end of the file", () => {
    const text = `---\nidea_id: ${IDEA_ID}\nkind: script\nversion: 1\nstatus: draft\n---`;
    expect(parseCompleteScriptFile(text).body).toBe("");
  });

  it("tolerates blank lines before the opening fence", () => {
    const parsed = parseScriptFile(`\n \n${exportedFile()}`);
    expect(parsed.hasFrontMatter).toBe(true);
    expect(parsed.frontMatter.version).toBe(3);
  });

  it("treats an empty block as front matter with no fields", () => {
    expect(parseScriptFile("---\n---\nbody")).toEqual({
      hasFrontMatter: true,
      frontMatter: {},
      body: "body",
    });
    expect(parseScriptFile("---\n# only a comment\n---\nbody").frontMatter).toEqual({});
  });

  it("does not treat a fence that is not the first non-blank line as front matter", () => {
    const text = "# Title\n\n---\nidea_id: x\n---\n";
    expect(parseScriptFile(text)).toEqual({ hasFrontMatter: false, frontMatter: {}, body: text });
  });

  it("does not treat '----' or '--- text' as a fence", () => {
    expect(parseScriptFile("----\nx\n----\n").hasFrontMatter).toBe(false);
    expect(parseScriptFile("--- not a fence\nx\n").hasFrontMatter).toBe(false);
  });

  it("returns a file with no front matter untouched apart from newline normalization", () => {
    expect(parseScriptFile("\n\n  # Leading blanks stay\r\n\r\n")).toEqual({
      hasFrontMatter: false,
      frontMatter: {},
      body: "\n\n  # Leading blanks stay\n\n",
    });
    expect(parseScriptFile("")).toEqual({ hasFrontMatter: false, frontMatter: {}, body: "" });
  });
});
