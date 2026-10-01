import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

// The web UI downloads this package with the Scripts screen on a phone, so its browser bundle must
// stay small: no zod (the "@ytw/shared" barrel pulls it in; this package must import the
// zod-free "@ytw/shared/constants" entry) and no Node built-ins.
const GZIP_BUDGET_BYTES = 50_000;

const packageDir = fileURLToPath(new URL("..", import.meta.url));

async function bundleForBrowser() {
  const result = await build({
    absWorkingDir: packageDir,
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    minify: true,
    conditions: ["@ytw/source"],
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("esbuild produced no output");
  return { code: output.contents, inputs: Object.keys(result.metafile.inputs), result };
}

describe("browser bundle", () => {
  it("does not pull in zod, the shared barrel or Node built-ins, and stays within the size budget", async () => {
    const { code, inputs, result } = await bundleForBrowser();

    expect(inputs.filter((path) => /(^|[\\/])zod([\\/]|$)/.test(path))).toEqual([]);
    expect(inputs.filter((path) => /shared[\\/]src[\\/](index|schemas)\.ts$/.test(path))).toEqual(
      [],
    );
    expect(inputs.some((path) => /[\\/]yaml[\\/]/.test(path))).toBe(true); // the check sees the real graph
    expect(inputs.some((path) => path.endsWith("shared/src/limits.ts"))).toBe(true);

    const nodeImports = Object.values(result.metafile.inputs).flatMap((input) =>
      input.imports.map((entry) => entry.path).filter((path) => path.startsWith("node:")),
    );
    expect(nodeImports).toEqual([]);

    const gzipped = gzipSync(code).length;
    expect(gzipped).toBeLessThan(GZIP_BUDGET_BYTES);
  }, 30_000);
});
