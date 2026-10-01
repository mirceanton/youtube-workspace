import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, apiRequest, setUnauthorizedHandler, withQuery } from "../../src/lib/api.ts";
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
  isClientError,
} from "../../src/lib/errors.ts";
import {
  browser,
  currentReturnTo,
  loginUrl,
  redirectToLogin,
  resetLoginRedirect,
} from "../../src/lib/navigation.ts";
import { fetchMe } from "../../src/lib/session.ts";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function stubFetch(...responses: (Response | Error | DOMException)[]): FetchMock {
  const mock: FetchMock = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Response) return next;
    throw next;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function lastRequest(mock: FetchMock, index = mock.mock.calls.length - 1) {
  const [url, init] = mock.mock.calls[index] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

beforeEach(() => {
  setUnauthorizedHandler(null);
});

afterEach(() => {
  setUnauthorizedHandler(null);
});

describe("withQuery", () => {
  it("encodes values, skips null and undefined, repeats arrays", () => {
    expect(withQuery("/api/x", { a: "b c", n: 3, no: null, un: undefined, t: ["x", "y"] })).toBe(
      "/api/x?a=b+c&n=3&t=x&t=y",
    );
    expect(withQuery("/api/x", {})).toBe("/api/x");
    expect(withQuery("/api/x?z=1", { a: 1 })).toBe("/api/x?z=1&a=1");
  });
});

describe("apiRequest: requests", () => {
  it("sends GET without a CSRF header or body", async () => {
    const mock = stubFetch(json({ ok: true }));
    await expect(api.get("/api/things", { query: { page: 2 } })).resolves.toEqual({ ok: true });
    const { url, init, headers } = lastRequest(mock);
    expect(url).toBe("/api/things?page=2");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.has("X-CSRF-Token")).toBe(false);
    expect(init.body).toBeUndefined();
  });

  it("sends JSON bodies on mutations with the CSRF token", async () => {
    setCsrfToken("tok-1");
    const mock = stubFetch(json({ id: 1 }, 201));
    await api.post("/api/things", { name: "x" });
    const { init, headers } = lastRequest(mock);
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"x"}');
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-CSRF-Token")).toBe("tok-1");
  });

  it.each(["put", "patch"] as const)("%s is a mutation too", async (method) => {
    setCsrfToken("tok-1");
    const mock = stubFetch(json({}));
    await api[method]("/api/things/1", { a: 1 });
    expect(lastRequest(mock).headers.get("X-CSRF-Token")).toBe("tok-1");
  });

  it("DELETE is a mutation and may return 204", async () => {
    setCsrfToken("tok-1");
    const mock = stubFetch(new Response(null, { status: 204 }));
    await expect(api.delete("/api/things/1")).resolves.toBeUndefined();
    expect(lastRequest(mock).headers.get("X-CSRF-Token")).toBe("tok-1");
  });

  it("passes raw bodies (uploads) through untouched", async () => {
    setCsrfToken("tok-1");
    const mock = stubFetch(json({}));
    const form = new FormData();
    form.append("file", new Blob(["x"]), "a.md");
    await apiRequest("/api/upload", { method: "POST", rawBody: form });
    const { init, headers } = lastRequest(mock);
    expect(init.body).toBe(form);
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("fetches the CSRF token from /api/me before the first mutation", async () => {
    const mock = stubFetch(json({}, 200, { "X-CSRF-Token": "fresh" }), json({ done: true }));
    await api.post("/api/things", {});
    expect(lastRequest(mock, 0).url).toBe("/api/me");
    expect(lastRequest(mock, 1).headers.get("X-CSRF-Token")).toBe("fresh");
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
    expect(lastRequest(mock, 2).headers.get("X-CSRF-Token")).toBe("rotated");
  });

  it("does not retry a real 403 (token unchanged) and reports it as ForbiddenError", async () => {
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

  it("never retries a GET that got 403", async () => {
    const mock = stubFetch(json({ error: "no" }, 403));
    await expect(api.get("/api/things")).rejects.toBeInstanceOf(ForbiddenError);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("apiRequest: errors", () => {
  it("maps 401 to UnauthorizedError and triggers the login redirect once", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    stubFetch(json({ error: "Not signed in" }, 401));
    const error = await api.get("/api/things").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("maps 404, 409 and other statuses to typed errors", async () => {
    stubFetch(
      json({ error: "No such idea" }, 404),
      json({ error: "Version 3 is stale", latest: { version: 5 } }, 409),
      json({ error: "boom" }, 500),
      new Response("<html>Bad gateway</html>", { status: 502 }),
    );
    const notFound = await api.get("/a").catch((e: unknown) => e);
    expect(notFound).toBeInstanceOf(NotFoundError);
    const conflict = await api.get("/b").catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ConflictError);
    expect((conflict as ConflictError).latest).toEqual({ version: 5 });
    expect((conflict as ConflictError).message).toBe("Version 3 is stale");
    expect((conflict as ConflictError).status).toBe(409);
    const server = await api.get("/c").catch((e: unknown) => e);
    expect(server).toBeInstanceOf(ApiError);
    expect(server).not.toBeInstanceOf(ConflictError);
    expect((server as ApiError).status).toBe(500);
    const html = await api.get("/d").catch((e: unknown) => e);
    expect((html as ApiError).status).toBe(502);
    expect((html as ApiError).message).toBe("The request failed with status 502.");
  });

  it("turns a fetch failure into NetworkError", async () => {
    stubFetch(new TypeError("Failed to fetch"));
    const error = await api.get("/api/things").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(describeError(error)).toMatch(/connection/i);
  });

  it("lets an aborted request surface as the abort, not as a network error", async () => {
    stubFetch(new DOMException("aborted", "AbortError"));
    const error = await api.get("/api/things").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NetworkError);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("validates responses with a parser and reports a mismatch as ResponseShapeError", async () => {
    const parser = {
      parse(data: unknown): { n: number } {
        if (
          typeof data === "object" &&
          data !== null &&
          typeof (data as { n?: unknown }).n === "number"
        ) {
          return { n: (data as { n: number }).n };
        }
        throw new Error("bad shape");
      },
    };
    stubFetch(json({ n: 1 }), json({ n: "x" }));
    await expect(api.get("/api/x", { parse: parser })).resolves.toEqual({ n: 1 });
    const error = await api.get("/api/x", { parse: parser }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponseShapeError);
  });

  it("classifies client errors for the retry policy", () => {
    expect(isClientError(new ForbiddenError("x"))).toBe(true);
    expect(isClientError(new ApiError("x", 500))).toBe(false);
    expect(isClientError(new NetworkError())).toBe(false);
  });
});

describe("fetchMe", () => {
  it("validates the body and remembers the CSRF token from the response header", async () => {
    stubFetch(
      json(
        {
          user: { id: "u", username: "owner", displayName: "O", email: "o@x.test", isAdmin: true },
          levels: {
            ideas: "write",
            scripts: "write",
            experiments: "write",
            videos: "write",
            notes: "write",
            activity: "read",
          },
        },
        200,
        { "X-CSRF-Token": "from-me" },
      ),
    );
    const me = await fetchMe();
    expect(me.user.username).toBe("owner");
    expect(getCsrfToken()).toBe("from-me");
  });

  it("reports a body this build cannot read as ResponseShapeError", async () => {
    stubFetch(json({ user: {}, levels: {} }));
    await expect(fetchMe()).rejects.toBeInstanceOf(ResponseShapeError);
  });
});

describe("login redirect", () => {
  beforeEach(() => {
    resetLoginRedirect();
  });

  it("builds /auth/login?return_to with the current same-origin path", () => {
    expect(loginUrl("/ideas?stage=inbox#top")).toBe(
      "/auth/login?return_to=%2Fideas%3Fstage%3Dinbox%23top",
    );
    expect(currentReturnTo({ pathname: "/scripts/1", search: "?v=2", hash: "" })).toBe(
      "/scripts/1?v=2",
    );
    expect(currentReturnTo({ pathname: "//evil.example", search: "", hash: "" })).toBe("/");
  });

  it("navigates once even when several requests fail with 401", () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    window.history.pushState({}, "", "/ideas?x=1");
    redirectToLogin();
    redirectToLogin();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/auth/login?return_to=%2Fideas%3Fx%3D1");
  });

  it("is what a 401 does by default", async () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    stubFetch(json({ error: "Not signed in" }, 401));
    await expect(api.get("/api/things")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0]?.[0])).toMatch(/^\/auth\/login\?return_to=/);
  });
});
