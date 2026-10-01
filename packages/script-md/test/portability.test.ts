import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SCRIPT_MD_ERROR_CODES,
  SCRIPT_MD_ERROR_STATUS,
  ScriptMdError,
  isScriptMdError,
} from "../src/index.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const sources = readdirSync(srcDir)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, text: readFileSync(join(srcDir, file), "utf8") }));

describe("browser portability of the parse/serialize core", () => {
  it("imports only @ytw/shared, yaml and sibling modules", () => {
    // "@ytw/shared/constants" is the zod-free entry; the "@ytw/shared" barrel would pull zod in.
    const allowed = /^(\.\/[\w-]+\.js|@ytw\/shared\/constants|yaml)$/;
    for (const { file, text } of sources) {
      for (const match of text.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
        expect(match[1], `${file} imports ${match[1]}`).toMatch(allowed);
      }
    }
  });

  it("uses no Node-only globals or APIs", () => {
    const forbidden = [
      /\bBuffer\b/,
      /\bprocess\b/,
      /\brequire\s*\(/,
      /__dirname/,
      /__filename/,
      /["']node:/,
      /\bfs\b/,
    ];
    for (const { file, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const pattern of forbidden) {
        expect(code, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("declares a single runtime dependency besides the workspace constants", () => {
    const manifest = JSON.parse(readFileSync(join(srcDir, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).toSorted()).toEqual(["@ytw/shared", "yaml"]);
  });
});

describe("ScriptMdError", () => {
  it("maps every code to an HTTP status: 413 for size limits, 400 for the rest", () => {
    const sizeCodes = ["file_too_large", "body_too_large", "front_matter_too_large"];
    for (const code of SCRIPT_MD_ERROR_CODES) {
      const error = new ScriptMdError(code, "message");
      expect(error.httpStatus).toBe(sizeCodes.includes(code) ? 413 : 400);
      expect(error.httpStatus).toBe(SCRIPT_MD_ERROR_STATUS[code]);
      expect(error.name).toBe("ScriptMdError");
      expect(error).toBeInstanceOf(Error);
      expect(isScriptMdError(error)).toBe(true);
    }
  });

  it("recognizes an error from another copy of the module by shape, and nothing else", () => {
    const foreign = Object.assign(new Error("x"), { name: "ScriptMdError", code: "kind_mismatch" });
    expect(isScriptMdError(foreign)).toBe(true);
    expect(
      isScriptMdError(Object.assign(new Error("x"), { name: "ScriptMdError", code: "nope" })),
    ).toBe(false);
    expect(
      isScriptMdError(Object.assign(new Error("x"), { name: "ScriptMdError", code: "toString" })),
    ).toBe(false);
    expect(isScriptMdError(new Error("x"))).toBe(false);
    expect(isScriptMdError("kind_mismatch")).toBe(false);
    expect(isScriptMdError(null)).toBe(false);
  });
});
