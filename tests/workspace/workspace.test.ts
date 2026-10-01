import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the workspace wiring that `pnpm lint`, `pnpm test` and `pnpm build` silently depend on.

const root = fileURLToPath(new URL("../..", import.meta.url));

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

/** Every workspace package directory, relative to the repository root. */
function workspacePackages(): string[] {
  const nested = ["packages", "apps"].flatMap((parent) =>
    readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`),
  );
  return [...nested, "e2e", "tests"].filter((dir) => existsSync(join(root, dir, "package.json")));
}

describe("workspace wiring", () => {
  const packages = workspacePackages();

  it("finds the packages", () => {
    expect(packages).toEqual(expect.arrayContaining(["packages/shared", "apps/web-ui", "tests"]));
  });

  it("references every package from the root tsconfig.json, so `tsc -b` checks it", () => {
    const { references } = readJson("tsconfig.json") as { references: { path: string }[] };
    expect(references.map((ref) => ref.path).toSorted()).toEqual(packages.toSorted());
  });

  it.each(packages)("%s has a vitest.config.ts based on vitest.shared.ts", (dir) => {
    const configPath = join(root, dir, "vitest.config.ts");
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain("vitest.shared.ts");
  });

  it("can import every workspace library this project depends on", async () => {
    const { devDependencies } = readJson("tests/package.json") as {
      devDependencies: Record<string, string>;
    };
    const libraries = Object.keys(devDependencies).filter((name) => name.startsWith("@ytw/"));
    expect(libraries.length).toBeGreaterThan(0);
    const withoutExports: string[] = [];
    for (const name of libraries) {
      const mod: Record<string, unknown> = await import(name);
      if (Object.keys(mod).length === 0) withoutExports.push(name);
    }
    expect(withoutExports).toEqual([]);
  });
});
