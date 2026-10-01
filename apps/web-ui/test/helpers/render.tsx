import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ResourceLevels } from "@ytw/shared/constants";
import type { ReactElement, ReactNode } from "react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { RootErrorBoundary } from "../../src/app/RootErrorBoundary.tsx";
import type { FeatureDefinition } from "../../src/app/features.ts";
import { buildRoutes } from "../../src/app/router.tsx";
import { createMockApi, PERSONAS, type MockApi, type PersonaName } from "../../src/dev/mock-api.ts";
import { SessionContext, type MeResponse } from "../../src/lib/session.ts";
import { vi } from "vitest";

/** A query client for tests: no retries, no background polling (tests refetch explicitly). */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0, gcTime: Infinity },
      mutations: { retry: false, networkMode: "always" },
    },
  });
}

export function personaSession(persona: PersonaName): MeResponse {
  const session = PERSONAS[persona];
  if (!session) throw new Error(`persona ${persona} has no session`);
  return session;
}

export function sessionWith(levels: Partial<ResourceLevels>, isAdmin = false): MeResponse {
  return {
    user: {
      id: "test-user",
      username: "tester",
      displayName: "Test User",
      email: "tester@example.test",
      isAdmin,
    },
    levels: {
      ideas: "none",
      scripts: "none",
      experiments: "none",
      videos: "none",
      notes: "none",
      activity: "none",
      ...levels,
    },
  };
}

/** Installs a mock API as the global `fetch` for the current test (restored by the setup file). */
export function stubApi(
  persona: PersonaName = "owner",
  options: { notes?: MockApi["notes"] } = {},
) {
  const api = createMockApi({ persona, ...options });
  vi.stubGlobal("fetch", api.fetch);
  return api;
}

export interface RenderKitOptions {
  /** The signed-in session the component sees. Default: the owner (Write on everything). */
  session?: MeResponse;
  client?: QueryClient;
  route?: string;
}

/**
 * Renders a kit component or screen the way the shell would: inside a query client, a router and
 * the session context, without going through `/api/me`.
 */
export function renderWithSession(
  ui: ReactElement,
  {
    session = personaSession("owner"),
    client = createTestQueryClient(),
    route = "/",
  }: RenderKitOptions = {},
): ReturnType<typeof render> & { client: QueryClient } {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <SessionContext value={session}>{children}</SessionContext>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  return { ...render(ui, { wrapper: Wrapper }), client };
}

/**
 * Renders the whole app (session gate, shell, feature routes) against the mock API at `route`.
 * Call `stubApi` first to choose the persona and to inspect requests.
 */
export function renderApp(
  features: readonly FeatureDefinition[],
  route = "/",
  client: QueryClient = createTestQueryClient(),
) {
  const router = createMemoryRouter(buildRoutes(features), { initialEntries: [route] });
  const result = render(
    <RootErrorBoundary>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </RootErrorBoundary>,
  );
  return { ...result, router, client };
}

export function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}
