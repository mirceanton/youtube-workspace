import { SCRIPT_KINDS, SCRIPT_STATUSES } from "@ytw/shared/constants";
import { describe, expect, it } from "vitest";
import {
  parseCompleteScriptFile,
  parseScriptFile,
  serializeScriptFile,
  type ScriptFile,
} from "../src/index.js";
import { IDEA_ID, catchScriptMdError, exportedFile } from "./helpers.js";

const base: ScriptFile = {
  ideaId: IDEA_ID,
  kind: "script",
  version: 3,
  status: "draft",
  body: "# Hook\n\nHello world.\n",
};
const head = `---\nidea_id: ${IDEA_ID}\nkind: script\nversion: 3\nstatus: draft\n---\n`;

describe("serializeScriptFile", () => {
  it("writes the canonical layout: fixed key order, blank line, LF newlines", () => {
    expect(serializeScriptFile(base)).toBe(`${head}\n# Hook\n\nHello world.\n`);
    expect(serializeScriptFile({ ...base, body: "" })).toBe(head);
    const crlf = serializeScriptFile({ ...base, ideaId: IDEA_ID.toUpperCase(), body: "a\r\nb\rc" });
    expect(crlf).toBe(`${head}\na\nb\nc`);
  });

  it.each([
    ["idea id not a uuid", { ideaId: "not-a-uuid" }],
    ["idea id with an injected line", { ideaId: `${IDEA_ID}\nstatus: approved` }],
    ["unknown kind", { kind: "outline" as never }],
    ["status with an injected line", { status: "draft\nversion: 9" as never }],
    ["negative version", { version: -1 }],
    ["version above the integer range", { version: 2_147_483_648 }],
    ["non-string body", { body: 42 as never }],
  ])("rejects %s with invalid_argument", (_name, patch) => {
    expect.hasAssertions();
    catchScriptMdError(() => serializeScriptFile({ ...base, ...patch }), "invalid_argument");
  });
});

describe("parseCompleteScriptFile", () => {
  it("reads every field of an exported file", () => {
    expect(parseCompleteScriptFile(exportedFile())).toEqual({
      ...base,
      body: "# Hook\n\nHello.\n",
    });
  });

  it("requires front matter and names the missing fields", () => {
    expect.hasAssertions();
    catchScriptMdError(() => parseCompleteScriptFile("# just a body\n"), "front_matter_invalid");
    const error = catchScriptMdError(
      () => parseCompleteScriptFile(`---\nidea_id: ${IDEA_ID}\nkind: script\n---\nbody`),
      "front_matter_invalid",
    );
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

  it("preserves awkward bodies: fences, blank edges, unicode, a BOM character inside", () => {
    const bodies = [
      "",
      "\n\n",
      "---",
      "---\nnot: front matter\n---\nstill body",
      "...\n",
      "emoji \u{1F600} and CJK 日本語\n",
      "﻿a BOM in the body is content, not a marker",
      "  \n \t\n",
    ];
    for (const body of bodies) {
      expect(parseCompleteScriptFile(serializeScriptFile({ ...base, body })).body).toBe(body);
    }
  });
});

describe("tolerant reading", () => {
  it("reads CRLF, lone CR and a leading BOM (text or bytes) like LF", () => {
    const lf = exportedFile({ body: "one\n\ntwo\n" });
    const expected = parseCompleteScriptFile(lf);
    expect(parseCompleteScriptFile(lf.replace(/\n/g, "\r\n"))).toEqual(expected);
    expect(parseCompleteScriptFile(lf.replace(/\n/g, "\r"))).toEqual(expected);
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(lf)]);
    expect(parseCompleteScriptFile(bytes)).toEqual(expected);
  });

  it("accepts hand-edited front matter: quotes, comments, extra keys, any order", () => {
    const text = [
      "---   ",
      "# exported by an agent",
      "status: 'review'   # keep",
      'version: "7"',
      `kind: "packaging"`,
      "title: Why Rust is fast",
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

  it("leaves a file without front matter alone, and refuses a block that would be dropped", () => {
    expect(parseScriptFile("\n  # Leading blanks stay\r\n")).toEqual({
      hasFrontMatter: false,
      frontMatter: {},
      body: "\n  # Leading blanks stay\n",
    });
    const error = catchScriptMdError(
      () => parseScriptFile("---\nUpdate: rewrote the cold open\n---\n\n# Cold open\n"),
      "front_matter_invalid",
    );
    expect(error.details).toEqual({ line: 1, reason: "no_known_keys" });
  });
});
