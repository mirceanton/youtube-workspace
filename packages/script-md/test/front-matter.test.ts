import { SCRIPT_BODY_MAX_BYTES } from "@ytw/shared/constants";
import { describe, expect, it } from "vitest";
import { FRONT_MATTER_MAX_BYTES, parseScriptFile, serializeScriptFile } from "../src/index.js";
import { IDEA_ID, catchScriptMdError, exportedFile } from "./helpers.js";

const header = `idea_id: ${IDEA_ID}\nkind: script\nversion: 3\nstatus: draft`;
const withFrontMatter = (yaml: string) => `---\n${yaml}\n---\nbody`;
const frame = (body: string) => exportedFile({ body });

describe("front matter errors", () => {
  it("reports an unterminated block, and a block over the byte limit", () => {
    expect.hasAssertions();
    catchScriptMdError(
      () => parseScriptFile(`---\n${header}\n\n# Body, no closing fence\n`),
      "front_matter_unterminated",
    );
    const oversize = `${header}\n# ${"x".repeat(FRONT_MATTER_MAX_BYTES)}`;
    const error = catchScriptMdError(
      () => parseScriptFile(withFrontMatter(oversize)),
      "front_matter_unterminated",
    );
    expect(error.details["limit"]).toBe(FRONT_MATTER_MAX_BYTES);
  });

  it.each([
    ["a tag", `${header}\nx: !!js/function 'function () {}'`],
    ["an anchor and alias", `${header}\nx: &a value\ny: *a`],
    ["a merge key", `base: &b {kind: script}\n<<: *b\n${header}`],
    ["a duplicate key", `${header}\nversion: 4`],
    ["a second document", `${header}\n...\nother: doc`],
    ["a sequence instead of a mapping", "- idea_id\n- kind"],
    ["nesting past the depth limit", `${header}\nx: [[[[y]]]]`],
  ])("rejects unsafe or malformed YAML: %s", (_name, yaml) => {
    const error = catchScriptMdError(
      () => parseScriptFile(withFrontMatter(yaml)),
      "front_matter_invalid",
    );
    expect(error.httpStatus).toBe(400);
  });

  it("does not coerce scalars: every value is text and must match its field", () => {
    for (const [field, value] of [
      ["version", "3.0"],
      ["version", "03"],
      ["version", "2147483648"],
      ["version", "[3]"],
      ["kind", "Script"],
      ["status", "published"],
      ["idea_id", `${IDEA_ID}x`],
    ] as const) {
      const fields = { idea_id: IDEA_ID, kind: "script", version: "3", status: "draft" };
      const yaml = Object.entries({ ...fields, [field]: value })
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      const error = catchScriptMdError(
        () => parseScriptFile(withFrontMatter(yaml)),
        "front_matter_invalid",
      );
      expect(error.details["field"], `${field}: ${value}`).toBe(field);
    }
  });

  it("names the field and file line of a bad value, and escapes what it echoes", () => {
    const bad = catchScriptMdError(
      () => parseScriptFile(withFrontMatter(header.replace("version: 3", "version: three"))),
      "front_matter_invalid",
    );
    expect(bad.details).toMatchObject({ field: "version", line: 4 });
    expect(bad.message).toContain('"three"');
    const hostile = catchScriptMdError(
      () => parseScriptFile(withFrontMatter(header.replace("draft", '"bad\\u001b[31m\\nvalue"'))),
      "front_matter_invalid",
    );
    expect([...hostile.message].every((char) => char.charCodeAt(0) >= 0x20)).toBe(true);
  });
});

describe("input limits", () => {
  it("accepts a body of exactly SCRIPT_BODY_MAX_BYTES and rejects one more byte", () => {
    const atLimit = "a".repeat(SCRIPT_BODY_MAX_BYTES);
    expect(parseScriptFile(frame(atLimit)).body).toHaveLength(SCRIPT_BODY_MAX_BYTES);
    const error = catchScriptMdError(() => parseScriptFile(frame(`${atLimit}a`)), "body_too_large");
    expect(error.httpStatus).toBe(413);
    expect(error.details).toMatchObject({ bytes: SCRIPT_BODY_MAX_BYTES + 1 });
  });

  it("counts bytes, not characters, and refuses to serialize a body it could not read back", () => {
    expect.hasAssertions();
    const body = "€".repeat(Math.floor(SCRIPT_BODY_MAX_BYTES / 3) + 1);
    catchScriptMdError(() => parseScriptFile(frame(body)), "body_too_large");
    const file = { ideaId: IDEA_ID, kind: "script", version: 1, status: "draft", body } as const;
    catchScriptMdError(() => serializeScriptFile(file), "body_too_large");
  });

  it("rejects invalid UTF-8, lone surrogates, NUL characters and non-text input", () => {
    expect.hasAssertions();
    catchScriptMdError(
      () => parseScriptFile(new Uint8Array([0x23, 0xff, 0xfe])),
      "invalid_encoding",
    );
    catchScriptMdError(() => parseScriptFile("text \uD83D more"), "invalid_encoding");
    catchScriptMdError(() => parseScriptFile("text\u0000more"), "invalid_characters");
    catchScriptMdError(() => parseScriptFile(42 as never), "invalid_argument");
  });
});
