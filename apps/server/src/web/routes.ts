import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

/** Load feature plugins from src/routes or dist/src/routes without a central feature registry. */
export async function registerFeatureRoutes(
  app: FastifyInstance,
  routeDirectory: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(routeDirectory);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  entries.sort();

  for (const entry of entries) {
    const directory = join(routeDirectory, entry);
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    const moduleFile = ["index.js", "index.ts"].find((file) => files.includes(file));
    if (moduleFile === undefined) continue;
    const moduleUrl = pathToFileURL(join(directory, moduleFile)).href;
    const loaded = (await import(moduleUrl)) as { default?: FastifyPluginAsync };
    if (typeof loaded.default !== "function") {
      throw new Error(`Web route plugin ${entry} must export a default Fastify plugin`);
    }
    await app.register(loaded.default);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
