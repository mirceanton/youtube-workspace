import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setUnauthorizedHandler, withQuery } from "../../src/lib/api.ts";
import { getCsrfToken, setCsrfToken } from "../../src/lib/csrf.ts";
import {
  ApiError,
  ConflictError,
  ForbiddenError,
  NetworkError,
  NotFoundError,
  ResponseShapeError,
  UnauthorizedError,
  describeError,
} from "../../src/lib/errors.ts";
import { browser } from "../../src/lib/navigation.ts";
import { shouldRetry } from "../../src/lib/query-client.ts";
import { fetchMe } from "../../src/lib/session.ts";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function stubFetch(...responses: (Response | Error)[]): FetchMock {
  const mock: FetchMock = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Response) return next;
    throw next;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function request(mock: FetchMock, index = mock.mock.calls.length - 1) {
  const [url, init] = mock.mock.calls[index] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

beforeEach(() => setUnauthorizedHandler(null));
afterEach(() => setUnauthorizedHandler(null));

describe("requests", () => {
  it("builds query strings: skips null/undefined, repeats arrays", () => {
    expect(withQuery("/api/x", { a: "b c", n: 3, no: null, un: undefined, t: ["x", "y"] })).toBe(
      "/api/x?a=b+c&n=3&t=x&t=y",
    );
    expect(withQuery("/api/x?z=1", { a: 1 })).toBe("/api/x?z=1&a=1");
  });

  it("sends GET without a CSRF header and mutations with it", async () => {
    setCsrfToken("tok-1");
    const mock = stubFetch(json({ ok: true }), json({ id: 1 }, 201));
    await api.get("/api/things", { query: { page: 2 } });
    expect(request(mock).url).toBe("/api/things?page=2");
    expect(request(mock).headers.has("X-CSRF-Token")).toBe(false);

    await api.post("/api/things", { name: "x" });
    const post = request(mock);
    expect(post.init.body).toBe('{"name":"x"}');
    expect(post.headers.get("Content-Type")).toBe("application/json");
    expect(post.headers.get("X-CSRF-Token")).toBe("tok-1");
  });

  it("fetches the CSRF token from /api/me before the first mutation", async () => {
    const mock = stubFetch(json({}, 200, { "X-CSRF-Token": "fresh" }), json({ done: true }));
    await api.post("/api/things", {});
    expect(request(mock, 0).url).toBe("/api/me");
    expect(request(mock, 1).headers.get("X-CSRF-Token")).toBe("fresh");
    expect(getCsrfToken()).toBe("fresh");
  });

  it("retries a 403 once when the server rotated the CSRF token", async () => {
    setCsrfToken("old");
    const mock = stubFetch(
      json({ error: "bad csrf" }, 403),
      json({}, 200, { "X-CSRF-Token": "rotated" }),
      json({ saved: true }),
    );
    await expect(api.post("/api/things", {})).resolves.toEqual({ saved: true });
    expect(request(mock, 2).headers.get("X-CSRF-Token")).toBe("rotated");
  });

  it("reports a real 403 (token unchanged) without retrying the mutation", async () => {
    setCsrfToken("same");
    const mock = stubFetch(
      json({ error: "You need write access to ideas" }, 403),
      json({}, 200, { "X-CSRF-Token": "same" }),
    );
    const error = await api.post("/api/things", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).message).toBe("You need write access to ideas");
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe("errors", () => {
  it("maps 401 to UnauthorizedError and calls the login handler", async () => {
    const handler = vi.fn<() => void>();
    setUnauthorizedHandler(handler);
    stubFetch(json({ error: "Not signed in" }, 401));
    await expect(api.get("/api/things")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("redirects to /auth/login with the current path on 401, once for parallel requests", async () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    window.history.pushState({}, "", "/ideas?x=1");
    stubFetch(json({ error: "Not signed in" }, 401), json({ error: "Not signed in" }, 401));
    await Promise.allSettled([api.get("/api/a"), api.get("/api/b")]);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/auth/login?return_to=%2Fideas%3Fx%3D1");
  });

  it("maps 409 to ConflictError carrying the latest version", async () => {
    stubFetch(json({ error: "Version 3 is stale", latest: { version: 5 } }, 409));
    const error = await api.get("/a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).latest).toEqual({ version: 5 });
    expect((error as ConflictError).message).toBe("Version 3 is stale");
  });

  it("maps 404, other statuses and non-JSON bodies to typed errors", async () => {
    stubFetch(
      json({ error: "No such idea" }, 404),
      json({ error: "boom" }, 500),
      new Response("<html>Bad gateway</html>", { status: 502 }),
    );
    expect(await api.get("/a").catch((e: unknown) => e)).toBeInstanceOf(NotFoundError);
    const server = (await api.get("/b").catch((e: unknown) => e)) as ApiError;
    expect(server).not.toBeInstanceOf(ConflictError);
    expect(server.status).toBe(500);
    const html = (await api.get("/c").catch((e: unknown) => e)) as ApiError;
    expect(html.message).toBe("The request failed with status 502.");
  });

  it("turns a fetch failure into NetworkError but lets an abort through", async () => {
    stubFetch(new TypeError("Failed to fetch"), new DOMException("aborted", "AbortError"));
    const network = await api.get("/api/things").catch((e: unknown) => e);
    expect(network).toBeInstanceOf(NetworkError);
    expect(describeError(network)).toMatch(/connection/i);
    const abort = await api.get("/api/things").catch((e: unknown) => e);
    expect((abort as DOMException).name).toBe("AbortError");
  });

  it("validates responses with a parser and reports a mismatch as ResponseShapeError", async () => {
    const parser = {
      parse(data: unknown): { n: number } {
        if (typeof (data as { n?: unknown }).n === "number") return data as { n: number };
        throw new Error("bad shape");
      },
    };
    stubFetch(json({ n: 1 }), json({ n: "x" }));
    await expect(api.get("/api/x", { parse: parser })).resolves.toEqual({ n: 1 });
    await expect(api.get("/api/x", { parse: parser })).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it("retries network and server failures, never client errors", () => {
    expect(shouldRetry(0, new NetworkError())).toBe(true);
    expect(shouldRetry(0, new ApiError("x", 500))).toBe(true);
    expect(shouldRetry(2, new ApiError("x", 500))).toBe(false);
    expect(shouldRetry(0, new ForbiddenError("x"))).toBe(false);
    expect(shouldRetry(0, new ConflictError("x", undefined))).toBe(false);
    expect(shouldRetry(0, new ResponseShapeError("/x", new Error("bad")))).toBe(false);
  });
});

describe("fetchMe", () => {
  it("validates the body and remembers the CSRF token from the response header", async () => {
    const levels = { ideas: "write", scripts: "write", experiments: "write", videos: "write" };
    stubFetch(
      json(
        {
          user: { id: "u", username: "owner", displayName: "O", email: "o@x.test", isAdmin: true },
          levels: { ...levels, notes: "write", activity: "read" },
        },
        200,
        { "X-CSRF-Token": "from-me" },
      ),
      json({ user: {}, levels: {} }),
    );
    expect((await fetchMe()).user.username).toBe("owner");
    expect(getCsrfToken()).toBe("from-me");
    await expect(fetchMe()).rejects.toBeInstanceOf(ResponseShapeError);
  });
});
