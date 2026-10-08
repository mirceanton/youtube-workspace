import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Component as TokenDetailPage } from "@/features/settings/TokenDetailPage.tsx";
import { Component as UserAccessPage } from "@/features/settings/UserAccessPage.tsx";
import { setCsrfToken } from "@/lib/csrf.ts";
import { SessionContext } from "@/lib/session.ts";
import { createTestQueryClient, sessionWith } from "../../helpers/render.tsx";

const USER_ID = "1fbd801d-3d42-4dc1-b50c-51fd5d42f492";
const TOKEN_ID = "2d90905d-2551-44bd-92f1-ced6b16c10c9";
const SECRET = "ytw_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123456789";
const STAMP = "2026-10-04T12:00:00.000Z";
const DENIAL = "This action is blocked by the last-admin rule.";

const levels = {
  ideas: "read",
  scripts: "read",
  experiments: "read",
  videos: "read",
  notes: "read",
  activity: "read",
} as const;

const profile = {
  profile: {
    id: USER_ID,
    username: "owner",
    display_name: "Workspace Owner",
    email: "owner@example.test",
    issuer: "https://issuer.example/realm",
    subject: "owner-subject",
    is_admin: false,
    access_revoked_at: null,
  },
  levels,
};

const token = {
  id: TOKEN_ID,
  name: "automation",
  prefix: "ytw_AbCd1234",
  status: "active",
  created_at: STAMP,
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  levels,
  effective_levels: levels,
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function renderRoute(element: ReactElement, path: string, entry: string, isAdmin = false) {
  const client = createTestQueryClient();
  const router = createMemoryRouter([{ path, element }], { initialEntries: [entry] });
  render(
    <QueryClientProvider client={client}>
      <SessionContext value={sessionWith(levels, isAdmin)}>
        <RouterProvider router={router} />
      </SessionContext>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  setCsrfToken(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("settings mutation failures", () => {
  it("shows a last-admin demotion denial inside its confirmation dialog", async () => {
    setCsrfToken("settings-csrf");
    const soleAdmin = {
      id: USER_ID,
      username: "owner",
      display_name: "Workspace Owner",
      email: "owner@example.test",
      is_admin: true,
      created_at: STAMP,
      last_login_at: STAMP,
      access_revoked_at: null,
      levels: { ...levels, activity: "read" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/settings/users" && method === "GET") {
          return jsonResponse({ users: [soleAdmin] });
        }
        if (url === `/api/settings/users/${USER_ID}/admin` && method === "PATCH") {
          return jsonResponse({ error: DENIAL }, 403);
        }
        if (url === "/api/me") {
          return jsonResponse({}, 200, { "X-CSRF-Token": "settings-csrf" });
        }
        return jsonResponse({ error: `Unexpected ${method} ${url}` }, 404);
      }),
    );

    const user = userEvent.setup();
    renderRoute(<UserAccessPage />, "/settings/users/:userId", `/settings/users/${USER_ID}`, true);
    await screen.findByRole("heading", { name: "Workspace Owner" });
    await user.click(screen.getByRole("button", { name: "Demote admin" }));
    const dialog = screen.getByRole("dialog", { name: "Demote this admin?" });
    await user.click(within(dialog).getByRole("button", { name: "Demote admin" }));

    expect(await within(dialog).findByText(DENIAL)).toBeVisible();
    expect(screen.getAllByText(DENIAL)).toHaveLength(1);
  });

  it("shows a revoke denial inside its confirmation dialog", async () => {
    setCsrfToken("settings-csrf");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/settings/profile") return jsonResponse(profile);
        if (url === "/api/settings/tokens" && method === "GET") {
          return jsonResponse({ tokens: [token] });
        }
        if (url === `/api/settings/tokens/${TOKEN_ID}` && method === "DELETE") {
          return jsonResponse({ error: "Token revoke denied by policy." }, 403);
        }
        if (url === "/api/me") {
          return jsonResponse({}, 200, { "X-CSRF-Token": "settings-csrf" });
        }
        return jsonResponse({ error: `Unexpected ${method} ${url}` }, 404);
      }),
    );

    const user = userEvent.setup();
    renderRoute(<TokenDetailPage />, "/settings/tokens/:tokenId", `/settings/tokens/${TOKEN_ID}`);
    await screen.findByRole("heading", { name: "automation" });
    await user.click(screen.getByRole("button", { name: "Revoke token" }));
    const dialog = screen.getByRole("dialog", { name: "Revoke this token?" });
    await user.click(within(dialog).getByRole("button", { name: "Revoke token" }));

    const denial = "Token revoke denied by policy.";
    expect(await within(dialog).findByText(denial)).toBeVisible();
    expect(screen.getAllByText(denial)).toHaveLength(1);
  });

  it("drops a rotated secret from the mutation cache after its dialog is dismissed", async () => {
    setCsrfToken("settings-csrf");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/settings/profile") return jsonResponse(profile);
        if (url === "/api/settings/tokens" && method === "GET") {
          return jsonResponse({ tokens: [token] });
        }
        if (url === `/api/settings/tokens/${TOKEN_ID}/rotate` && method === "POST") {
          return jsonResponse({ token, secret: SECRET });
        }
        return jsonResponse({ error: `Unexpected ${method} ${url}` }, 404);
      }),
    );

    const user = userEvent.setup();
    const client = renderRoute(
      <TokenDetailPage />,
      "/settings/tokens/:tokenId",
      `/settings/tokens/${TOKEN_ID}`,
    );
    await screen.findByRole("heading", { name: "automation" });
    await user.click(screen.getByRole("button", { name: "Rotate secret" }));
    await screen.findByText(SECRET);
    await user.click(screen.getByRole("button", { name: "I saved it" }));

    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    await waitFor(() => {
      const mutations = client.getMutationCache().getAll();
      expect(
        mutations.some(
          (mutation) =>
            mutation.options.mutationKey?.[0] === "settings" &&
            mutation.options.mutationKey?.[1] === "rotateToken",
        ),
      ).toBe(false);
      expect(JSON.stringify(mutations.map((mutation) => mutation.state.data))).not.toContain(
        SECRET,
      );
    });
  });
});
