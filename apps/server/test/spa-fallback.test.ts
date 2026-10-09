import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installSpaFallback } from "../src/web/static.js";

const PAGE = "text/html,application/xhtml+xml";

let dir: string;
let anonymous: FastifyInstance;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ytw-spa-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>app</title>");
  anonymous = Fastify();
  installSpaFallback(anonymous, dir, async (request) => {
    request.auth = undefined;
  });
  await anonymous.ready();
});

afterAll(async () => {
  await anonymous.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the web app fallback without a session", () => {
  it("sends a page request to the login", async () => {
    const page = await anonymous.inject({ url: "/ideas", headers: { accept: PAGE } });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe("/auth/login?return_to=%2Fideas");
  });

  it("does not start a login for the icons a browser fetches on its own", async () => {
    // Each login would replace the cookie of the sign-in that is under way in the same browser.
    for (const url of [
      "/favicon.ico",
      "/apple-touch-icon.png",
      "/apple-touch-icon-precomposed.png",
    ]) {
      const icon = await anonymous.inject({ url, headers: { accept: "*/*" } });
      expect(icon.statusCode).toBe(404);
      expect(icon.headers.location).toBeUndefined();
      expect(icon.headers["set-cookie"]).toBeUndefined();
    }
  });
});
