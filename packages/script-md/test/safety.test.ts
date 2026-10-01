import { SCRIPT_BODY_MAX_BYTES } from "@ytw/shared";
import { describe, expect, it } from "vitest";
import {
  FRONT_MATTER_MAX_BYTES,
  FRONT_MATTER_MAX_DEPTH,
  SCRIPT_FILE_MAX_INPUT_BYTES,
  parseScriptFile,
  prepareUpload,
  serializeScriptFile,
  utf8ByteLength,
} from "../src/index.js";
import { IDEA_ID, catchScriptMdError, exportedFile, seededRandom } from "./helpers.js";

const FENCE_HEAD = "---\n";

function withFrontMatter(yaml: string, body = "body"): string {
  return `${FENCE_HEAD}${yaml}\n---\n${body}`;
}

const header = `idea_id: ${IDEA_ID}\nkind: script\nversion: 3\nstatus: draft`;

const frame = (body: string) => exportedFile({ body });

describe("size limits (bytes, not characters)", () => {
  it("accepts a body of exactly SCRIPT_BODY_MAX_BYTES and rejects one more byte", () => {
    const atLimit = "a".repeat(SCRIPT_BODY_MAX_BYTES);
    expect(parseScriptFile(frame(atLimit)).body.length).toBe(SCRIPT_BODY_MAX_BYTES);
    const error = catchScriptMdError(() => parseScriptFile(frame(`${atLimit}a`)), "body_too_large");
    expect(error.httpStatus).toBe(413);
    expect(error.details["limit"]).toBe(SCRIPT_BODY_MAX_BYTES);
    expect(error.details["bytes"]).toBe(SCRIPT_BODY_MAX_BYTES + 1);
    expect(error.message).toContain("1048576");
  });

  it("counts multi-byte characters as bytes: fewer than 1 Mi characters can still be too large", () => {
    const chars = Math.floor(SCRIPT_BODY_MAX_BYTES / 2) + 1; // 'e acute' is 2 bytes
    const body = "\u00E9".repeat(chars);
    expect(body.length).toBeLessThan(SCRIPT_BODY_MAX_BYTES);
    catchScriptMdError(() => parseScriptFile(frame(body)), "body_too_large");
    // And exactly at the limit with 2-byte characters passes.
    const fits = "\u00E9".repeat(SCRIPT_BODY_MAX_BYTES / 2);
    expect(utf8ByteLength(fits)).toBe(SCRIPT_BODY_MAX_BYTES);
    expect(parseScriptFile(frame(fits)).body).toBe(fits);
  });

  it("counts 4-byte characters (emoji) as 4 bytes", () => {
    const fits = "\u{1F600}".repeat(SCRIPT_BODY_MAX_BYTES / 4);
    expect(parseScriptFile(frame(fits)).body).toBe(fits);
    catchScriptMdError(() => parseScriptFile(frame(`${fits}x`)), "body_too_large");
  });

  it("does not count the front matter against the body limit", () => {
    const atLimit = "a".repeat(SCRIPT_BODY_MAX_BYTES);
    const padded = withFrontMatter(`${header}\n# ${"c".repeat(4000)}`, atLimit);
    expect(parseScriptFile(padded).body).toBe(atLimit);
  });

  it("measures the body after CRLF conversion, so a CRLF file of 1 MiB of newlines fits", () => {
    const crlf = "\r\n".repeat(SCRIPT_BODY_MAX_BYTES); // 2 MiB raw, 1 MiB normalized
    const head = exportedFile({ body: "" }).replace(/\n/g, "\r\n");
    const parsed = parseScriptFile(`${head}${crlf}`);
    expect(parsed.body.length).toBe(SCRIPT_BODY_MAX_BYTES);
    expect(SCRIPT_FILE_MAX_INPUT_BYTES).toBeGreaterThan(crlf.length);
  });

  it("rejects a normalized body one byte over even when the raw file is CRLF", () => {
    expect.hasAssertions();
    const crlf = "\r\n".repeat(SCRIPT_BODY_MAX_BYTES + 1);
    const head = exportedFile({ body: "" }).replace(/\n/g, "\r\n");
    catchScriptMdError(() => parseScriptFile(`${head}${crlf}`), "body_too_large");
  });

  it("rejects absurdly large input before parsing it", () => {
    const huge = "a".repeat(SCRIPT_FILE_MAX_INPUT_BYTES + 1);
    const error = catchScriptMdError(() => parseScriptFile(huge), "file_too_large");
    expect(error.httpStatus).toBe(413);
    catchScriptMdError(
      () => parseScriptFile(new Uint8Array(SCRIPT_FILE_MAX_INPUT_BYTES + 1)),
      "file_too_large",
    );
    catchScriptMdError(
      () => prepareUpload("x".repeat(64 * 1024 * 1024), { ideaId: IDEA_ID, kind: "script" }),
      "file_too_large",
    );
  });

  it("refuses to serialize a body over the limit, so every exported file can be uploaded again", () => {
    expect.hasAssertions();
    catchScriptMdError(
      () =>
        serializeScriptFile({
          ideaId: IDEA_ID,
          kind: "script",
          version: 1,
          status: "draft",
          body: "a".repeat(SCRIPT_BODY_MAX_BYTES + 1),
        }),
      "body_too_large",
    );
  });

  it("matches TextEncoder for the byte count, including lone surrogates", () => {
    const samples = [
      "",
      "abc",
      "\u00E9",
      "\u20AC",
      "\u{1F600}",
      "a\uD83Db",
      "\uDE00",
      "\uD83D",
      "\u{1F600}\uD83D",
    ];
    const wrong = samples.filter(
      (sample) => utf8ByteLength(sample) !== new TextEncoder().encode(sample).length,
    );
    expect(wrong).toEqual([]);
    const random = seededRandom(7);
    for (let i = 0; i < 500; i++) {
      let sample = "";
      for (let j = 0; j < 20; j++) sample += String.fromCharCode(Math.floor(random() * 0x10000));
      expect(utf8ByteLength(sample)).toBe(new TextEncoder().encode(sample).length);
    }
  });
});

describe("front matter size and structure", () => {
  it("rejects a front matter block over the byte limit", () => {
    const error = catchScriptMdError(
      () => parseScriptFile(withFrontMatter(`${header}\n# ${"x".repeat(FRONT_MATTER_MAX_BYTES)}`)),
      "front_matter_unterminated",
    );
    expect(error.details["limit"]).toBe(FRONT_MATTER_MAX_BYTES);
  });

  it("rejects a block that is over the byte limit only because of multi-byte characters", () => {
    const yaml = `${header}\n# ${"\u00E9".repeat(FRONT_MATTER_MAX_BYTES / 2)}`;
    expect(yaml.length).toBeLessThan(FRONT_MATTER_MAX_BYTES);
    const error = catchScriptMdError(
      () => parseScriptFile(withFrontMatter(yaml)),
      "front_matter_too_large",
    );
    expect(error.httpStatus).toBe(413);
  });

  it("accepts a block of exactly the byte limit", () => {
    const filler = FRONT_MATTER_MAX_BYTES - utf8ByteLength(`${header}\n# \n`);
    const yaml = `${header}\n# ${"x".repeat(filler)}`;
    expect(utf8ByteLength(`${yaml}\n`)).toBe(FRONT_MATTER_MAX_BYTES);
    expect(parseScriptFile(withFrontMatter(yaml)).frontMatter.version).toBe(3);
  });

  it("does not run away on a single huge line after the opening fence", () => {
    expect.hasAssertions();
    catchScriptMdError(
      () => parseScriptFile(`---\n${"y".repeat(1_500_000)}\n---\n`),
      "front_matter_unterminated",
    );
    catchScriptMdError(
      () => parseScriptFile(`---\n${"y".repeat(1_500_000)}`),
      "front_matter_unterminated",
    );
  });

  it("reports an unterminated block and suggests the fix", () => {
    const error = catchScriptMdError(
      () => parseScriptFile(`---\n${header}\n\n# Body, no closing fence\n`),
      "front_matter_unterminated",
    );
    expect(error.message).toContain('"---"');
    catchScriptMdError(() => parseScriptFile("---"), "front_matter_unterminated");
    catchScriptMdError(() => parseScriptFile("---\n"), "front_matter_unterminated");
  });

  it("rejects deeply nested flow collections without overflowing the stack", () => {
    for (const depth of [FRONT_MATTER_MAX_DEPTH + 1, 50, 1000, 4000]) {
      const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
      const error = catchScriptMdError(
        () => parseScriptFile(withFrontMatter(`${header}\nextra: ${nested}`)),
        "front_matter_invalid",
      );
      expect(error.httpStatus).toBe(400);
    }
    catchScriptMdError(
      () => parseScriptFile(withFrontMatter(`extra: ${"{a: ".repeat(1500)}${"}".repeat(1500)}`)),
      "front_matter_invalid",
    );
    catchScriptMdError(
      () => parseScriptFile(withFrontMatter(`extra: ${"[".repeat(8000)}`)),
      "front_matter_invalid",
    );
  });

  it("rejects deeply nested block collections", () => {
    let yaml = header;
    let indent = "";
    for (let i = 0; i < 60; i++) {
      yaml += `\n${indent}k${i}:`;
      indent += " ";
    }
    const error = catchScriptMdError(
      () => parseScriptFile(withFrontMatter(yaml)),
      "front_matter_invalid",
    );
    expect(error.message).toContain(`${FRONT_MATTER_MAX_DEPTH} levels`);
    catchScriptMdError(
      () => parseScriptFile(withFrontMatter(`extra:\n${"- ".repeat(2000)}x`)),
      "front_matter_invalid",
    );
  });

  it("accepts nesting up to the depth limit", () => {
    const ok = `${header}\nextra: [[[x]]]`; // mapping(1) > seq(2) > seq(3) > seq(4)
    expect(parseScriptFile(withFrontMatter(ok)).frontMatter.version).toBe(3);
    catchScriptMdError(
      () => parseScriptFile(withFrontMatter(`${header}\nextra: [[[[x]]]]`)),
      "front_matter_invalid",
    );
  });
});

describe("unsafe YAML", () => {
  const rejected: Array<[string, string]> = [
    ["a JS function tag", `${header}\nx: !!js/function 'function () { process.exit(1) }'`],
    ["a python object tag", `${header}\nx: !!python/object/apply:os.system ['echo pwned']`],
    ["a local custom tag", `${header}\nx: !custom value`],
    ["a binary tag", `${header}\nx: !!binary aGVsbG8=`],
    [
      "an explicit string tag on a known field",
      `idea_id: !!str ${IDEA_ID}\nkind: script\nversion: 3\nstatus: draft`,
    ],
    ["a tag on a collection", `${header}\nx: !!set {a, b}`],
    ["an anchor", `${header}\nx: &a value`],
    ["an alias", `${header}\nx: &a value\ny: *a`],
    ["an alias to an undefined anchor", `${header}\ny: *missing`],
    ["a merge key", `base: &b {kind: script}\n<<: *b\n${header}`],
    [
      "an alias bomb (billion laughs)",
      [
        "a: &a [x,x,x,x,x,x,x,x,x]",
        "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]",
        "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]",
        "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]",
        "e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]",
        header,
      ].join("\n"),
    ],
    ["a duplicate key", `${header}\nversion: 4`],
    ["a duplicate nested key", `${header}\nx: {a: 1, a: 2}`],
    ["a complex (non-text) key", `${header}\n? [a, b]\n: c`],
    ["a YAML directive", `%YAML 1.2\n${header}`],
    ["a second document", `${header}\n...\nother: doc`],
    ["a sequence instead of a mapping", "- idea_id\n- kind"],
    ["a bare scalar", "just some words"],
    ["broken syntax", `${header}\nx: [unclosed`],
    ["a bad indent", `${header}\n  stray: indent\n nope: x`],
  ];

  it.each(rejected)("rejects %s", (_name, yaml) => {
    const error = catchScriptMdError(
      () => parseScriptFile(withFrontMatter(yaml)),
      "front_matter_invalid",
    );
    expect(error.httpStatus).toBe(400);
    // The message is actionable and does not echo large amounts of hostile input.
    expect(error.message.length).toBeLessThan(600);
  });

  it("never executes anything: a tag payload stays inert", () => {
    const globals = globalThis as { ytwPwned?: boolean };
    globals.ytwPwned = false;
    const yaml = `${header}\nx: !!js/function 'function(){ globalThis.ytwPwned = true }()'`;
    catchScriptMdError(() => parseScriptFile(withFrontMatter(yaml)), "front_matter_invalid");
    expect(globals.ytwPwned).toBe(false);
  });

  it("is safe for prototype-pollution keys: they are ignored and nothing leaks onto Object", () => {
    const yaml = `${header}\n__proto__: {polluted: yes}\nconstructor: {prototype: {polluted: yes}}`;
    const parsed = parseScriptFile(withFrontMatter(yaml));
    expect(parsed.frontMatter).toEqual({
      ideaId: IDEA_ID,
      kind: "script",
      version: 3,
      status: "draft",
    });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.keys(parsed.frontMatter)).not.toContain("__proto__");
  });

  it("ignores unknown keys with plain values", () => {
    const parsed = parseScriptFile(
      withFrontMatter(`${header}\ntitle: Hello\nowner: me\nnested:\n  a: 1`),
    );
    expect(parsed.frontMatter).toEqual({
      ideaId: IDEA_ID,
      kind: "script",
      version: 3,
      status: "draft",
    });
  });

  it("does not coerce scalars: numbers, booleans and dates stay text and fail validation", () => {
    for (const [field, value] of [
      ["version", "3.0"],
      ["version", "0x10"],
      ["version", "1e3"],
      ["version", "-1"],
      ["version", "+3"],
      ["version", "3 4"],
      ["version", "99999999999"],
      ["version", "2147483648"],
      ["version", "true"],
      ["kind", "Script"],
      ["kind", "true"],
      ["status", "yes"],
      ["status", "Draft"],
      ["status", "published"],
      ["idea_id", "12345"],
      ["idea_id", `${IDEA_ID}x`],
      ["idea_id", `{${IDEA_ID}}`],
    ] as const) {
      const fields: Record<string, string> = {
        idea_id: IDEA_ID,
        kind: "script",
        version: "3",
        status: "draft",
        [field]: value,
      };
      const yaml = Object.entries(fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      const error = catchScriptMdError(
        () => parseScriptFile(withFrontMatter(yaml)),
        "front_matter_invalid",
      );
      expect(error.details["field"], `${field}: ${value}`).toBe(field);
    }
  });

  it.each([
    ["an empty value", "version:"],
    ["a null value", "version: null"],
    ["a list value", "version: [3]"],
    ["a mapping value", "version: {a: 1}"],
    ["a block scalar with a trailing newline", "kind: |\n  script"],
  ])("rejects a known field with %s", (_name, line) => {
    const key = line.slice(0, line.indexOf(":"));
    const rest = ["idea_id: " + IDEA_ID, "kind: script", "version: 3", "status: draft"].filter(
      (l) => !l.startsWith(`${key}:`),
    );
    const error = catchScriptMdError(
      () => parseScriptFile(withFrontMatter([...rest, line].join("\n"))),
      "front_matter_invalid",
    );
    expect(error.details["field"]).toBe(key);
  });

  it("reports the file line of a bad field", () => {
    const error = catchScriptMdError(
      () => parseScriptFile(withFrontMatter(`${header.replace("version: 3", "version: three")}`)),
      "front_matter_invalid",
    );
    expect(error.details["field"]).toBe("version");
    expect(error.details["line"]).toBe(4);
    expect(error.message).toContain("version must be a whole number");
    expect(error.message).toContain('"three"');
  });

  it("escapes control characters when echoing a bad value", () => {
    const error = catchScriptMdError(
      () =>
        parseScriptFile(
          withFrontMatter(`${header.replace("status: draft", 'status: "bad\\u001b[31m\\nvalue"')}`),
        ),
      "front_matter_invalid",
    );
    expect(error.details["field"]).toBe("status");
    expect(error.message).toContain("\\u001b");
    expect([...error.message].every((char) => char.charCodeAt(0) >= 0x20)).toBe(true);
  });
});

describe("binary and hostile bytes", () => {
  it("rejects invalid UTF-8", () => {
    const error = catchScriptMdError(
      () => parseScriptFile(new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0xfd])),
      "invalid_encoding",
    );
    expect(error.message).toContain("UTF-8");
    catchScriptMdError(() => parseScriptFile(new Uint8Array([0xc3, 0x28])), "invalid_encoding"); // bad continuation
    catchScriptMdError(
      () => parseScriptFile(new Uint8Array([0xed, 0xa0, 0x80])),
      "invalid_encoding",
    ); // encoded surrogate
    catchScriptMdError(
      () => parseScriptFile(new Uint8Array([0xf8, 0x88, 0x80, 0x80, 0x80])),
      "invalid_encoding",
    ); // 5-byte form
  });

  it("rejects random binary data", () => {
    const random = seededRandom(1234);
    for (let i = 0; i < 50; i++) {
      const bytes = new Uint8Array(2048);
      for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(random() * 256);
      let error: unknown;
      try {
        parseScriptFile(bytes);
      } catch (caught) {
        error = caught;
      }
      expect(error, `sample ${i}`).toMatchObject({ name: "ScriptMdError" });
      expect(["invalid_encoding", "invalid_characters"]).toContain(
        (error as { code: string }).code,
      );
    }
  });

  it("rejects NUL characters anywhere: body, front matter, text and bytes", () => {
    expect.hasAssertions();
    catchScriptMdError(() => parseScriptFile("text\u0000more"), "invalid_characters");
    catchScriptMdError(
      () => parseScriptFile(exportedFile({ body: "a\u0000b" })),
      "invalid_characters",
    );
    catchScriptMdError(
      () => parseScriptFile(withFrontMatter(`${header}\nx: a\u0000b`)),
      "invalid_characters",
    );
    catchScriptMdError(
      () => parseScriptFile(new Uint8Array([0x61, 0x00, 0x62])),
      "invalid_characters",
    );
  });

  it("rejects UTF-16 files (with or without a BOM)", () => {
    expect.hasAssertions();
    const text = exportedFile();
    const utf16le = new Uint8Array(2 + text.length * 2);
    utf16le.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) utf16le[2 + i * 2] = text.charCodeAt(i);
    catchScriptMdError(() => parseScriptFile(utf16le), "invalid_encoding");
    catchScriptMdError(() => parseScriptFile(utf16le.subarray(2)), "invalid_characters");
  });

  it("rejects input that is neither a string nor bytes", () => {
    expect.hasAssertions();
    catchScriptMdError(() => parseScriptFile(42 as never), "invalid_argument");
    catchScriptMdError(() => parseScriptFile(null as never), "invalid_argument");
    catchScriptMdError(
      () => parseScriptFile({ toString: () => "---" } as never),
      "invalid_argument",
    );
  });

  it("accepts Buffer-like Uint8Array subclasses and views with an offset", () => {
    const encoded = new TextEncoder().encode(`xx${exportedFile()}`);
    const view = encoded.subarray(2);
    expect(parseScriptFile(view).frontMatter.version).toBe(3);
  });
});

describe("markdown that looks risky is data, not markup", () => {
  it("leaves HTML, script tags and links in the body untouched (rendering sanitizes, not this package)", () => {
    const body =
      "<script>alert(1)</script>\n[x](javascript:alert(1))\n<img src=x onerror=alert(1)>\n";
    expect(parseScriptFile(exportedFile({ body })).body).toBe(body);
  });
});
