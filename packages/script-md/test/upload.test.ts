import { describe, expect, it } from "vitest";
import {
  MAX_SCRIPT_VERSION,
  parseBaseVersion,
  parseVersionText,
  prepareUpload,
} from "../src/index.js";
import { IDEA_ID, OTHER_IDEA_ID, catchScriptMdError, exportedFile } from "./helpers.js";

const target = { ideaId: IDEA_ID, kind: "script" } as const;

describe("prepareUpload", () => {
  it("strips the front matter and takes the base version from the file", () => {
    expect(prepareUpload(exportedFile({ body: "# New draft\n", version: 4 }), target)).toEqual({
      body: "# New draft\n",
      baseVersion: 4,
      hadFrontMatter: true,
      frontMatter: { ideaId: IDEA_ID, kind: "script", version: 4, status: "draft" },
    });
  });

  it("accepts a file without front matter and returns no base version", () => {
    const prepared = prepareUpload("# Just a body\n", target);
    expect(prepared).toEqual({ body: "# Just a body\n", hadFrontMatter: false, frontMatter: {} });
    expect("baseVersion" in prepared).toBe(false);
  });

  it("rejects a file exported from another idea or kind", () => {
    const idea = catchScriptMdError(
      () => prepareUpload(exportedFile({ ideaId: OTHER_IDEA_ID }), target),
      "idea_id_mismatch",
    );
    expect(idea.details).toEqual({ expected: IDEA_ID, actual: OTHER_IDEA_ID });
    catchScriptMdError(
      () => prepareUpload(exportedFile({ kind: "packaging" }), target),
      "kind_mismatch",
    );
  });

  it("combines the file's version with an explicit base version", () => {
    const upload = (version: number, baseVersion: number) =>
      prepareUpload(exportedFile({ version }), { ...target, baseVersion });
    expect(prepareUpload("body", { ...target, baseVersion: 0 }).baseVersion).toBe(0);
    expect(upload(6, 6).baseVersion).toBe(6);
    const error = catchScriptMdError(() => upload(3, 4), "base_version_mismatch");
    expect(error.details).toEqual({ expected: 4, actual: 3 });
  });
});

describe("version text", () => {
  it("accepts canonical digits from 0 to the integer maximum", () => {
    expect(parseVersionText("0")).toBe(0);
    expect(parseVersionText("2147483647")).toBe(MAX_SCRIPT_VERSION);
    expect(parseBaseVersion("12")).toBe(12);
  });

  it.each(["", " 3", "03", "+3", "-3", "1e3", "0x3", "3.0", "2147483648", "３"])(
    "rejects %j",
    (text) => {
      expect(parseVersionText(text)).toBeNull();
      expect(() => parseBaseVersion(text)).toThrow(/Invalid base_version/);
    },
  );
});
