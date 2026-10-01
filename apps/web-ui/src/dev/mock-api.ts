// The single dev-only mock layer: an in-memory implementation of the web contract
// (`/api/me`, CSRF, `/api/notes`) behind a fetch-compatible function.
//
// It is used in two places: `installDevMocks()` (src/dev/install.ts) puts it in front of
// `window.fetch` under `pnpm dev` when no web server answers, and the component tests use it as
// their fake backend, so tests and the dev app exercise the same contract. Production builds never
// import this module (main.tsx reaches it only through `import.meta.env.DEV`), so it is tree-shaken
// away together with its zod schemas. Features can add routes with `src/features/<f>/mock.ts`.

import {
  NOTES_PATH,
  createNoteRequestSchema,
  listNotesQuerySchema,
  type Note,
} from "@ytw/shared/api/notes";
import { CSRF_HEADER, ME_PATH, type MeResponse } from "@ytw/shared/api/session";
import type { ResourceLevels } from "@ytw/shared/constants";

export type PersonaName = "owner" | "collaborator" | "reader" | "newcomer" | "anonymous";

const ALL_READ: ResourceLevels = {
  ideas: "read",
  scripts: "read",
  experiments: "read",
  videos: "read",
  notes: "read",
  activity: "none",
};

/** The users of the PRD 7 example table, plus an admin, a user without access and a signed-out visitor. */
export const PERSONAS: Record<PersonaName, MeResponse | null> = {
  owner: {
    user: {
      id: "0199c2a4-0000-7000-8000-000000000001",
      username: "owner",
      displayName: "Channel Owner",
      email: "owner@example.test",
      isAdmin: true,
    },
    levels: {
      ideas: "write",
      scripts: "write",
      experiments: "write",
      videos: "write",
      notes: "write",
      activity: "read",
    },
  },
  collaborator: {
    user: {
      id: "0199c2a4-0000-7000-8000-000000000002",
      username: "collaborator",
      displayName: "Collaborator",
      email: "collaborator@example.test",
      isAdmin: false,
    },
    levels: {
      ideas: "write",
      scripts: "write",
      experiments: "write",
      videos: "read",
      notes: "write",
      activity: "read",
    },
  },
  reader: {
    user: {
      id: "0199c2a4-0000-7000-8000-000000000003",
      username: "reader",
      displayName: "Reader",
      email: "reader@example.test",
      isAdmin: false,
    },
    levels: ALL_READ,
  },
  newcomer: {
    user: {
      id: "0199c2a4-0000-7000-8000-000000000004",
      username: "newcomer",
      displayName: "New Person",
      email: "newcomer@example.test",
      isAdmin: false,
    },
    levels: {
      ideas: "none",
      scripts: "none",
      experiments: "none",
      videos: "none",
      notes: "none",
      activity: "none",
    },
  },
  anonymous: null,
};

export function isPersonaName(value: unknown): value is PersonaName {
  return typeof value === "string" && value in PERSONAS;
}

export interface MockRequest {
  method: string;
  url: URL;
  /** `:name` segments of the matched pattern. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body, if any. */
  body: unknown;
  /** The signed-in persona, or null when anonymous. */
  session: MeResponse | null;
}

export type MockResult = Response | { status?: number; json?: unknown; headers?: HeadersInit };
export type MockHandler = (request: MockRequest, api: MockApi) => MockResult | Promise<MockResult>;

export interface MockRouter {
  on(method: string, pattern: string, handler: MockHandler): void;
  get(pattern: string, handler: MockHandler): void;
  post(pattern: string, handler: MockHandler): void;
  put(pattern: string, handler: MockHandler): void;
  patch(pattern: string, handler: MockHandler): void;
  delete(pattern: string, handler: MockHandler): void;
}

export interface MockApi {
  /** Drop-in for `fetch`. Only `/api/*` URLs are handled; others go to `passthrough`. */
  fetch: typeof fetch;
  router: MockRouter;
  setPersona(name: PersonaName): void;
  /** Replace the session wholesale (tests: odd level combinations). */
  setSession(session: MeResponse | null): void;
  session(): MeResponse | null;
  /** Rotates the CSRF token the server expects. */
  rotateCsrfToken(): string;
  csrfToken(): string;
  /** Every request seen, oldest first: method, path+query and the CSRF header it carried. */
  requests: { method: string; path: string; csrf: string | null; body: unknown }[];
  /** All stored notes (tests assert on them). */
  notes: Note[];
  /** Entity ids that answer 404 on note creation. */
  missingEntities: Set<string>;
}

export interface MockApiOptions {
  persona?: PersonaName;
  /** Artificial delay in ms per request. */
  latencyMs?: number;
  /** Used for non-/api URLs. Defaults to the real fetch captured at creation. */
  passthrough?: typeof fetch;
  /** Notes to start with. */
  notes?: Note[];
}

export function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function errorResponse(status: number, error: string, extra?: Record<string, unknown>) {
  return jsonResponse({ error, ...extra }, status);
}

function toResponse(result: MockResult): Response {
  if (result instanceof Response) return result;
  return jsonResponse(result.json ?? {}, result.status ?? 200, result.headers);
}

function compile(pattern: string): { regex: RegExp; names: string[] } {
  const names: string[] = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        names.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${source}/?$`), names };
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `0199c2a4-7b1e-7c3a-9d2f-${counter.toString(16).padStart(12, "0")}`;
}

/** A level check for mock handlers: returns the 401/403 response, or undefined when allowed. */
export function requireMockLevel(
  request: MockRequest,
  resource: keyof ResourceLevels,
  level: "read" | "write",
): Response | undefined {
  if (!request.session) return errorResponse(401, "Not signed in");
  const have = request.session.levels[resource];
  const ok = level === "read" ? have !== "none" : have === "write";
  return ok ? undefined : errorResponse(403, `You need ${level} access to ${resource}`);
}

export function createMockApi(options: MockApiOptions = {}): MockApi {
  const realFetch = options.passthrough ?? globalThis.fetch?.bind(globalThis);
  let session: MeResponse | null = PERSONAS[options.persona ?? "owner"];
  let csrf = "mock-csrf-token-1";
  const routes: { method: string; regex: RegExp; names: string[]; handler: MockHandler }[] = [];
  const api: MockApi = {
    fetch: undefined as unknown as typeof fetch,
    router: undefined as unknown as MockRouter,
    setPersona(name) {
      session = PERSONAS[name];
    },
    setSession(next) {
      session = next;
    },
    session: () => session,
    rotateCsrfToken() {
      csrf = `mock-csrf-token-${Number(csrf.split("-").at(-1)) + 1}`;
      return csrf;
    },
    csrfToken: () => csrf,
    requests: [],
    notes: options.notes ?? [],
    missingEntities: new Set(),
  };

  const on = (method: string, pattern: string, handler: MockHandler) => {
    routes.push({ method: method.toUpperCase(), ...compile(pattern), handler });
  };
  api.router = {
    on,
    get: (p, h) => on("GET", p, h),
    post: (p, h) => on("POST", p, h),
    put: (p, h) => on("PUT", p, h),
    patch: (p, h) => on("PATCH", p, h),
    delete: (p, h) => on("DELETE", p, h),
  };

  // --- the web contract ---------------------------------------------------------------------
  api.router.get(ME_PATH, (request) => {
    if (!request.session) return errorResponse(401, "Not signed in");
    return jsonResponse(request.session, 200, { [CSRF_HEADER]: csrf });
  });

  api.router.get(NOTES_PATH, (request) => {
    const denied = requireMockLevel(request, "notes", "read");
    if (denied) return denied;
    const parsed = listNotesQuerySchema.safeParse(Object.fromEntries(request.query));
    if (!parsed.success)
      return errorResponse(400, parsed.error.issues[0]?.message ?? "Invalid query");
    const { entity_type, entity_id } = parsed.data;
    return jsonResponse({
      notes: api.notes.filter((n) => n.entity_type === entity_type && n.entity_id === entity_id),
    });
  });

  api.router.post(NOTES_PATH, (request) => {
    const denied = requireMockLevel(request, "notes", "write");
    if (denied) return denied;
    const parsed = createNoteRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return errorResponse(400, parsed.error.issues[0]?.message ?? "Invalid note");
    if (api.missingEntities.has(parsed.data.entity_id)) {
      return errorResponse(404, `No ${parsed.data.entity_type} with id ${parsed.data.entity_id}`);
    }
    const now = new Date().toISOString();
    const note: Note = {
      id: newId(),
      entity_type: parsed.data.entity_type,
      entity_id: parsed.data.entity_id,
      author: request.session?.user.username ?? "unknown",
      actor_type: "human",
      body_md: parsed.data.body_md,
      created_at: now,
      updated_at: now,
    };
    api.notes.push(note);
    return jsonResponse({ note }, 201);
  });

  // --- the fetch function -------------------------------------------------------------------
  api.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(
      request ? request.url : String(input instanceof URL ? input.href : input),
      "http://localhost",
    );
    if (!url.pathname.startsWith("/api/")) {
      if (!realFetch) throw new Error(`mock fetch: no passthrough for ${url.pathname}`);
      return realFetch(input, init);
    }
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const rawBody = init?.body ?? undefined;
    let body: unknown;
    if (typeof rawBody === "string" && rawBody !== "") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    api.requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      csrf: headers.get(CSRF_HEADER),
      body,
    });
    if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));

    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
    if (unsafe) {
      if (!session) return errorResponse(401, "Not signed in");
      if (headers.get(CSRF_HEADER) !== csrf) {
        return errorResponse(403, "CSRF token missing or invalid");
      }
    }
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(
        route.names.map((name, i) => [name, decodeURIComponent(match[i + 1] ?? "")]),
      );
      return toResponse(
        await route.handler({ method, url, params, query: url.searchParams, body, session }, api),
      );
    }
    return errorResponse(404, `The mock API has no ${method} ${url.pathname}`);
  };
  return api;
}
