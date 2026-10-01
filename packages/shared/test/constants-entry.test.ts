import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as barrel from "../src/index.js";
import * as constants from "../src/constants.js";

const CONSTANT_MODULES = ["enums", "idea-stages", "limits", "resources", "constants"];

describe('"@ytw/shared/constants" entry point', () => {
  it.each(CONSTANT_MODULES)("src/%s.ts does not import zod or the schemas", (name) => {
    const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["']zod/);
    expect(source).not.toMatch(/from\s+["']\.\/schemas/);
  });

  it("exposes the same values as the barrel, minus the zod schemas", () => {
    const schemaNames = Object.keys(barrel).filter((name) => name.endsWith("Schema"));
    const expected = Object.keys(barrel)
      .filter((name) => !schemaNames.includes(name))
      .toSorted();
    expect(Object.keys(constants).toSorted()).toEqual(expected);
    expect(schemaNames.length).toBeGreaterThan(0);
  });
});
