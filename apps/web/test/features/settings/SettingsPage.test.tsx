import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setCsrfToken } from "@/lib/csrf.ts";
import { Component as SettingsPage } from "@/features/settings/SettingsPage.tsx";
import { sessionWith } from "../../helpers/render.tsx";
import { createTestQueryClient, renderWithSession } from "../../helpers/render.tsx";
import { afterEach, describe, expect, it, vi } from "vitest";

const USER_ID = "b3f5ddf1-8a0d-4ed1-9d61-283c6f90a450";
const TOKEN_ID = "d4d1c91d-780b-4d90-920f-f3277431a5f1";
const SECRET = "ytw_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123456789";
const NOW = new Date("2026-10-04T12:00:00.000Z");
const EXPIRY = new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();

function allLevels(scripts: "none" | "read" | "write") {
  return {
    ideas: "none",
    scripts,
    experiments: "none",
    videos: "none",
    notes: "none",
    activity: "none",
  } as const;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SettingsPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers only owner-grantable levels and discards a secret after its one-time dialog closes", async () => {
    const token = {
      id: TOKEN_ID,
      name: "script helper",
      prefix: "ytw_abcd1234",
      status: "active",
      created_at: NOW.toISOString(),
      expires_at: EXPIRY,
      last_used_at: null,
      revoked_at: null,
      levels: allLevels("read"),
      effective_levels: allLevels("read"),
    };
    const profile = {
      profile: {
        id: USER_ID,
        username: "reader",
        display_name: "Script Reader",
        email: "reader@example.test",
        issuer: "https://issuer.example/realms/channel",
        subject: "stable-subject",
        is_admin: false,
        access_revoked_at: null,
      },
      levels: allLevels("read"),
    };
    const requestLog: Array<{ url: string; method: string; body: unknown }> = [];
    let tokens: (typeof token)[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
        requestLog.push({ url, method, body });
        if (url === "/api/settings/profile") return response(profile);
        if (url === "/api/settings/tokens" && method === "GET") return response({ tokens });
        if (url === "/api/settings/tokens" && method === "POST") {
          tokens = [token];
          return response({ token, secret: SECRET }, 201);
        }
        return response({ error: "Not found" }, 404);
      }),
    );
    setCsrfToken("csrf-test-value");
    const user = userEvent.setup();
    const client = createTestQueryClient();
    renderWithSession(<SettingsPage />, {
      client,
      session: sessionWith({ scripts: "read" }),
    });

    await screen.findByText("Script Reader");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API token" });
    const scripts = within(dialog).getByRole("combobox", { name: "Scripts permission" });
    expect(
      within(scripts)
        .getAllByRole("option")
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["none", "read"]);
    const ideas = within(dialog).getByRole("combobox", { name: "Ideas permission" });
    expect(
      within(ideas)
        .getAllByRole("option")
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["none"]);
    const activity = within(dialog).getByRole("combobox", { name: "Activity log permission" });
    expect(
      within(activity)
        .getAllByRole("option")
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["none"]);

    await user.type(within(dialog).getByRole("textbox", { name: "Token name" }), "script helper");
    await user.selectOptions(scripts, "read");
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));

    await screen.findByText(SECRET);
    await waitFor(() =>
      expect(
        requestLog.some((item) => item.url === "/api/settings/tokens" && item.method === "GET"),
      ).toBe(true),
    );
    const getRequests = requestLog.filter(
      (item) => item.url === "/api/settings/tokens" && item.method === "GET",
    );
    expect(JSON.stringify(getRequests)).not.toContain(SECRET);
    expect(requestLog.some((item) => item.url === `/api/settings/tokens/${TOKEN_ID}`)).toBe(false);

    await user.click(screen.getByRole("button", { name: "I saved it" }));
    await waitFor(() => expect(screen.queryByText(SECRET)).not.toBeInTheDocument());
    await waitFor(() => {
      const mutations = client.getMutationCache().getAll();
      expect(
        mutations.some(
          (mutation) =>
            mutation.options.mutationKey?.[0] === "settings" &&
            mutation.options.mutationKey?.[1] === "createToken",
        ),
      ).toBe(false);
      expect(JSON.stringify(mutations.map((mutation) => mutation.state.data))).not.toContain(
        SECRET,
      );
    });
    expect(JSON.stringify(requestLog.filter((item) => item.method === "GET"))).not.toContain(
      SECRET,
    );
    expect(await screen.findByText("script helper")).toBeInTheDocument();
  });
});
