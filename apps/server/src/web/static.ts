import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AuthMode } from "./types.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function requestPath(request: FastifyRequest): string | undefined {
  try {
    return decodeURIComponent(new URL(request.url, "http://web.local").pathname);
  } catch {
    return undefined;
  }
}

async function fileResponse(
  root: string,
  path: string,
  reply: FastifyReply,
  request: FastifyRequest,
): Promise<boolean> {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, `.${path}`);
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${sep}`)) return false;
  try {
    const metadata = await stat(target);
    if (!metadata.isFile()) return false;
    const contents = await readFile(target);
    reply.type(CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream");
    reply.header("Content-Length", contents.byteLength);
    reply.header(
      "Cache-Control",
      path === "/index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    );
    reply.send(request.method === "HEAD" ? undefined : contents);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Browsers fetch icons and manifests on their own (`/favicon.ico`, `/apple-touch-icon.png`) with
 * no session and no `text/html` in `Accept`. Sending those to the login would start a login
 * transaction each, and every one replaces the cookie of the sign-in the user is in the middle of.
 */
function wantsPage(request: FastifyRequest): boolean {
  return request.headers.accept?.includes("text/html") === true;
}

/**
 * Everything no route matched: unknown API paths answer 401 or 404 as JSON. When the built web app
 * is available (`root`), its files are served publicly and every other path gets the app's
 * `index.html` (client-side routing) once the request has a session; without one a page request is
 * sent to the login first, and anything else is not found.
 */
export function installSpaFallback(
  app: FastifyInstance,
  root: string | undefined,
  loadSession: AuthMode["loadSession"],
): void {
  app.setNotFoundHandler(async (request, reply) => {
    const path = requestPath(request);
    if (path === undefined) return reply.code(400).send({ error: "Invalid path." });
    if (path.startsWith("/api/") || path === "/api") {
      return request.auth === undefined
        ? reply.code(401).send({ error: "Authentication required." })
        : reply.code(404).send({ error: "Not found." });
    }
    if (path.startsWith("/auth/") || path === "/auth") {
      return reply.code(404).send({ error: "Not found." });
    }
    if (root === undefined || (request.method !== "GET" && request.method !== "HEAD")) {
      return reply.code(404).send({ error: "Not found." });
    }
    if (path !== "/" && (await fileResponse(root, path, reply, request))) return reply;
    await loadSession(request, reply);
    if (request.auth === undefined) {
      if (!wantsPage(request)) return reply.code(404).send({ error: "Not found." });
      const returnTo = encodeURIComponent(
        `${path}${new URL(request.url, "http://web.local").search}`,
      );
      return reply.redirect(`/auth/login?return_to=${returnTo}`, 302);
    }
    if (await fileResponse(root, "/index.html", reply, request)) return reply;
    return reply.code(404).send({ error: "The web app has not been built." });
  });
}
