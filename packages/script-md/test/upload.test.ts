import { SCRIPT_BODY_MAX_BYTES } from "@ytw/shared/constants";
import { describe, expect, it } from "vitest";
import { parseCompleteScriptFile, prepareUpload, serializeScriptFile } from "../src/index.js";
import { IDEA_ID, OTHER_IDEA_ID, catchScriptMdError, exportedFile } from "./helpers.js";

const target = { ideaId: IDEA_ID, kind: "script" } as const;

describe("prepareUpload", () => {
  it("strips the front matter and returns the body with the base version from the file", () => {
    expect(prepareUpload(exportedFile({ body: "# New draft\n", version: 4 }), target)).toEqual({
      body: "# New draft\n",
      baseVersion: 4,
      hadFrontMatter: true,
      frontMatter: { ideaId: IDEA_ID, kind: "script", version: 4, status: "draft" },
    });
  });

  it("round-trips an export: download, upload unchanged gives back the same body and version", () => {
    const body = "# Title\r\n\r\nText with trailing space  \n";
    const exported = serializeScriptFile({
      ideaId: IDEA_ID,
      kind: "script",
      version: 9,
      status: "review",
      body,
    });
    const prepared = prepareUpload(exported, target);
    expect(prepared.body).toBe(body.replace(/\r\n/g, "\n"));
    expect(prepared.baseVersion).toBe(9);
  });

  it("accepts a file without front matter and returns no base version", () => {
    const prepared = prepareUpload("# Just a body\n", target);
    expect(prepared).toEqual({ body: "# Just a body\n", hadFrontMatter: false, frontMatter: {} });
    expect("baseVersion" in prepared).toBe(false);
  });

  it("uses an explicit base version when the file has none", () => {
    expect(prepareUpload("body", { ...target, baseVersion: 5 }).baseVersion).toBe(5);
    expect(
      prepareUpload(`---\nstatus: draft\n---\nbody`, { ...target, baseVersion: 0 }).baseVersion,
    ).toBe(0);
  });

  it("accepts an explicit base version that agrees with the file", () => {
    expect(
      prepareUpload(exportedFile({ version: 6 }), { ...target, baseVersion: 6 }).baseVersion,
    ).toBe(6);
  });

  it("rejects an explicit base version that disagrees with the file", () => {
    const error = catchScriptMdError(
      () => prepareUpload(exportedFile({ version: 6 }), { ...target, baseVersion: 8 }),
      "base_version_mismatch",
    );
    expect(error.httpStatus).toBe(400);
    expect(error.details).toEqual({ expected: 8, actual: 6 });
    expect(error.message).toContain('change the front matter line to "version: 8"');
    expect(error.message).toContain("re-download the latest version");
  });

  it("can require a base version", () => {
    const error = catchScriptMdError(
      () => prepareUpload("no front matter", { ...target, requireBaseVersion: true }),
      "base_version_missing",
    );
    expect(error.httpStatus).toBe(400);
    expect(prepareUpload(exportedFile(), { ...target, requireBaseVersion: true }).baseVersion).toBe(
      3,
    );
    expect(
      prepareUpload("x", { ...target, requireBaseVersion: true, baseVersion: 2 }).baseVersion,
    ).toBe(2);
  });

  it("ignores the status in the file: it is returned for information only", () => {
    const prepared = prepareUpload(exportedFile({ status: "approved" }), target);
    expect(prepared.frontMatter.status).toBe("approved");
    expect(Object.keys(prepared).toSorted()).toEqual([
      "baseVersion",
      "body",
      "frontMatter",
      "hadFrontMatter",
    ]);
  });

  describe("target mismatches", () => {
    it("rejects a different idea_id with a typed error", () => {
      const error = catchScriptMdError(
        () => prepareUpload(exportedFile({ ideaId: OTHER_IDEA_ID }), target),
        "idea_id_mismatch",
      );
      expect(error.httpStatus).toBe(400);
      expect(error.details).toEqual({ expected: IDEA_ID, actual: OTHER_IDEA_ID });
      expect(error.message).toContain(OTHER_IDEA_ID);
      expect(error.message).toContain(IDEA_ID);
    });

    it("rejects a different kind with a typed error", () => {
      const error = catchScriptMdError(
        () => prepareUpload(exportedFile({ kind: "packaging" }), target),
        "kind_mismatch",
      );
      expect(error.httpStatus).toBe(400);
      expect(error.details).toEqual({ expected: "script", actual: "packaging" });
    });

    it("compares idea ids case-insensitively", () => {
      expect(prepareUpload(exportedFile({ ideaId: IDEA_ID.toUpperCase() }), target).body).toBe(
        "# Hook\n\nHello.\n",
      );
      expect(
        prepareUpload(exportedFile(), { ...target, ideaId: IDEA_ID.toUpperCase() }).baseVersion,
      ).toBe(3);
    });

    it("only checks the fields the file provides", () => {
      expect(prepareUpload(`---\nversion: 2\n---\nbody`, target).baseVersion).toBe(2);
      expect(prepareUpload(`---\nkind: script\n---\nbody`, target).body).toBe("body");
      catchScriptMdError(
        () => prepareUpload(`---\nkind: packaging\n---\nbody`, target),
        "kind_mismatch",
      );
    });

    it("does not report a mismatch before an invalid front matter value", () => {
      expect.hasAssertions();
      catchScriptMdError(
        () => prepareUpload(`---\nidea_id: ${OTHER_IDEA_ID}\nversion: x\n---\n`, target),
        "front_matter_invalid",
      );
    });
  });

  describe("a leading block that is not our front matter", () => {
    it("refuses to drop it silently (the block would otherwise be lost)", () => {
      const text = "---\nUpdate: rewrote the cold open\n---\n\n# Cold open\n";
      const error = catchScriptMdError(() => prepareUpload(text, target), "front_matter_invalid");
      expect(error.httpStatus).toBe(400);
      expect(error.message).toContain("Remove the block");
      expect(error.message).toContain("add the keys");
    });

    it("refuses an empty or comment-only block as well", () => {
      expect.hasAssertions();
      catchScriptMdError(() => prepareUpload("---\n---\nbody", target), "front_matter_invalid");
      catchScriptMdError(
        () => prepareUpload("---\n# note\n---\nbody", target),
        "front_matter_invalid",
      );
    });

    it("still strips a block that has at least one of the four keys", () => {
      const prepared = prepareUpload("---\nUpdate: note\nstatus: review\n---\nbody", target);
      expect(prepared.body).toBe("body");
      expect(prepared.frontMatter).toEqual({ status: "review" });
    });
  });

  describe("base version precedence", () => {
    const fileV3 = exportedFile({ version: 3 });
    const noVersion = `---\nidea_id: ${IDEA_ID}\nkind: script\n---\nbody`;
    const cases: Array<{
      name: string;
      input: string;
      baseVersion?: number;
      expected: number | undefined;
    }> = [
      { name: "file only", input: fileV3, expected: 3 },
      { name: "option only", input: noVersion, baseVersion: 4, expected: 4 },
      { name: "no front matter, option only", input: "body", baseVersion: 0, expected: 0 },
      { name: "both and equal", input: fileV3, baseVersion: 3, expected: 3 },
      { name: "neither", input: noVersion, expected: undefined },
    ];

    it.each(cases)("$name", ({ input, baseVersion, expected }) => {
      const options = { ...target, ...(baseVersion === undefined ? {} : { baseVersion }) };
      expect(prepareUpload(input, options).baseVersion).toBe(expected);
    });

    it("both and different: neither value wins, the call fails with a 400", () => {
      const error = catchScriptMdError(
        () => prepareUpload(fileV3, { ...target, baseVersion: 4 }),
        "base_version_mismatch",
      );
      expect(error.httpStatus).toBe(400);
      expect(error.message).toContain('"version: 3"');
      expect(error.message).toContain('"version: 4"');
    });

    it("an agent that merged into an old copy fixes the mismatch by updating the version line", () => {
      const merged = exportedFile({ version: 3, body: "merged\n" });
      catchScriptMdError(
        () => prepareUpload(merged, { ...target, baseVersion: 4 }),
        "base_version_mismatch",
      );
      const updated = merged.replace("version: 3", "version: 4");
      expect(prepareUpload(updated, { ...target, baseVersion: 4 })).toMatchObject({
        body: "merged\n",
        baseVersion: 4,
      });
      const stripped = merged.replace("version: 3\n", "");
      expect(prepareUpload(stripped, { ...target, baseVersion: 4 })).toMatchObject({
        body: "merged\n",
        baseVersion: 4,
      });
    });
  });

  it("accepts a Node Buffer, the form a Fastify buffer body parser hands over", () => {
    const text = `\uFEFF${exportedFile({ body: "caf\u00E9\r\n" })}`;
    const prepared = prepareUpload(Buffer.from(text, "utf8"), target);
    expect(prepared).toMatchObject({ body: "caf\u00E9\n", baseVersion: 3 });
    catchScriptMdError(() => prepareUpload(Buffer.from([0xc3, 0x28]), target), "invalid_encoding");
  });

  describe("limits", () => {
    it("rejects a body over the byte limit with a 413-class error", () => {
      const error = catchScriptMdError(
        () => prepareUpload(exportedFile({ body: "a".repeat(SCRIPT_BODY_MAX_BYTES + 1) }), target),
        "body_too_large",
      );
      expect(error.httpStatus).toBe(413);
    });

    it("rejects an unterminated front matter instead of storing it as body text", () => {
      expect.hasAssertions();
      catchScriptMdError(
        () => prepareUpload(`---\nidea_id: ${IDEA_ID}\n\n# Body`, target),
        "front_matter_unterminated",
      );
    });
  });

  describe("invalid targets", () => {
    it.each([
      ["a malformed idea id", { ideaId: "../../etc/passwd", kind: "script" as const }],
      ["an unknown kind", { ideaId: IDEA_ID, kind: "outline" as never }],
      ["a negative base version", { ...target, baseVersion: -1 }],
      ["a fractional base version", { ...target, baseVersion: 1.2 }],
      ["a NaN base version", { ...target, baseVersion: Number.NaN }],
    ])("rejects %s", (_name, bad) => {
      expect.hasAssertions();
      catchScriptMdError(() => prepareUpload("body", bad), "invalid_argument");
    });
  });

  it("reads bytes and strings identically, including a BOM and CRLF", () => {
    const text = `\uFEFF${exportedFile({ body: "a\nb\n" }).replace(/\n/g, "\r\n")}`;
    const fromString = prepareUpload(text, target);
    const fromBytes = prepareUpload(new TextEncoder().encode(text), target);
    expect(fromBytes).toEqual(fromString);
    expect(fromString.body).toBe("a\nb\n");
  });

  it("the edit loop works: export, edit the body locally, upload, and the new body is what was written", () => {
    const exported = serializeScriptFile({
      ideaId: IDEA_ID,
      kind: "packaging",
      version: 2,
      status: "approved",
      body: "Title: Old\n",
    });
    const edited = exported.replace("Title: Old", "Title: New");
    const prepared = prepareUpload(edited, { ideaId: IDEA_ID, kind: "packaging" });
    expect(prepared.body).toBe("Title: New\n");
    expect(prepared.baseVersion).toBe(2);
    expect(parseCompleteScriptFile(edited).status).toBe("approved");
  });
});
