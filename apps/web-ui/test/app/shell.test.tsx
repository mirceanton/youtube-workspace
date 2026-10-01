import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Star } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineFeature, discoverFeatures, type FeatureDefinition } from "../../src/app/features.ts";
import { PERSONAS } from "../../src/dev/mock-api.ts";
import { browser } from "../../src/lib/navigation.ts";
import { ME_QUERY_KEY, type MeResponse } from "../../src/lib/session.ts";
import { expectNoA11yViolations } from "../helpers/a11y.ts";
import { renderApp, setOnline, stubApi } from "../helpers/render.tsx";

const fixtures = discoverFeatures(
  import.meta.glob("../fixtures/features/*/routes.tsx", { eager: true }),
);

function extra(id: string, order: number): FeatureDefinition {
  return defineFeature({
    id,
    requires: "authenticated",
    nav: { label: id[0]?.toUpperCase() + id.slice(1), icon: Star, order },
    routes: [{ path: id, element: <h1>{id} page</h1> }],
  });
}

const manyFeatures = [...fixtures, extra("epsilon", 70), extra("zeta", 80)];

afterEach(() => {
  setOnline(true);
});

function sidebar() {
  // Both navigations are in the DOM (CSS shows one per breakpoint); the sidebar is the <aside> one.
  const aside = document.querySelector("aside") as HTMLElement;
  return within(within(aside).getByRole("navigation", { name: "Main" }));
}

function bottomBar() {
  const bar = document.querySelector("nav.fixed") as HTMLElement;
  return within(bar);
}

describe("session gate", () => {
  it("shows a loading state, then the app, with the page for the route", async () => {
    stubApi("owner");
    renderApp(fixtures, "/alpha");
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Alpha list" }),
    ).toBeInTheDocument();
    expect(document.title).toBe("Alpha list · YouTube Workspace");
  });

  it("sends an anonymous visitor to the OIDC login and remembers where they were", async () => {
    stubApi("anonymous");
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    renderApp(fixtures, "/alpha");
    expect(await screen.findByRole("status")).toHaveTextContent(/Redirecting to sign in|Loading/);
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign.mock.calls[0]?.[0]).toMatch(/^\/auth\/login\?return_to=/);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("shows a retryable error when the server is down, and recovers", async () => {
    const api = stubApi("owner");
    let down = true;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      down
        ? Promise.resolve(
            new Response(JSON.stringify({ error: "Database unavailable" }), { status: 503 }),
          )
        : api.fetch(input, init),
    );
    const user = userEvent.setup();
    renderApp(fixtures, "/alpha");
    expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable");
    expect(
      screen.getByRole("heading", { name: "The workspace could not be loaded" }),
    ).toBeInTheDocument();
    down = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Alpha list" }),
    ).toBeInTheDocument();
  });

  it("shows the access-not-granted page when every level is None, with no navigation", async () => {
    stubApi("newcomer");
    renderApp(fixtures, "/alpha");
    expect(
      await screen.findByRole("heading", { name: "Access not granted yet" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/New Person/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Alpha list" })).toBeNull();
    expect(screen.getByRole("link", { name: "Sign out" })).toHaveAttribute("href", "/auth/logout");
  });

  it("lets the user check again, and shows the app once an admin has granted access", async () => {
    const api = stubApi("newcomer");
    const user = userEvent.setup();
    renderApp(fixtures, "/alpha");
    await screen.findByRole("heading", { name: "Access not granted yet" });
    api.setPersona("collaborator");
    await user.click(screen.getByRole("button", { name: /Check again/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Alpha list" }),
    ).toBeInTheDocument();
  });

  it("serves the access-denied page without asking for a session", async () => {
    const api = stubApi("anonymous");
    renderApp(fixtures, "/access-denied");
    expect(await screen.findByRole("heading", { name: "Access denied" })).toBeInTheDocument();
    expect(screen.getByText(/no account was created/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /different account/ })).toHaveAttribute(
      "href",
      "/auth/logout",
    );
    expect(api.requests).toEqual([]);
  });
});

describe("version mismatch: fail closed", () => {
  const withNewObjectType = {
    ...PERSONAS.owner,
    levels: { ...PERSONAS.owner?.levels, comments: "write" },
  };

  it("shows 'a new version is available' with a reload button instead of crashing, and renders no app", async () => {
    const api = stubApi("owner");
    api.setSession(withNewObjectType as unknown as MeResponse);
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderApp(fixtures, "/alpha");

    expect(
      await screen.findByRole("heading", { name: "A new version is available" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/no longer matches it/)).toBeInTheDocument();
    // Fail closed: nothing of the app is on screen, so there are no write controls to misjudge.
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Alpha list" })).toBeNull();
    expect(screen.queryByRole("button", { name: /add|save|create|delete/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("also fails closed when a later refresh returns a shape this build cannot read", async () => {
    const api = stubApi("owner");
    const { client } = renderApp(fixtures, "/alpha");
    await screen.findByRole("heading", { level: 1, name: "Alpha list" });

    api.setSession(withNewObjectType as unknown as MeResponse);
    await act(() => client.invalidateQueries({ queryKey: ME_QUERY_KEY }));
    expect(
      await screen.findByRole("heading", { name: "A new version is available" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("treats a missing level the same way", async () => {
    const api = stubApi("owner");
    const broken = structuredClone(PERSONAS.owner) as MeResponse;
    delete (broken.levels as Partial<MeResponse["levels"]>).notes;
    api.setSession(broken);
    renderApp(fixtures, "/alpha");
    expect(
      await screen.findByRole("heading", { name: "A new version is available" }),
    ).toBeInTheDocument();
  });

  it("does not retry the unreadable response over and over", async () => {
    const api = stubApi("owner");
    api.setSession(withNewObjectType as unknown as MeResponse);
    renderApp(fixtures, "/alpha");
    await screen.findByRole("heading", { name: "A new version is available" });
    expect(api.requests.filter((r) => r.path === "/api/me")).toHaveLength(1);
  });
});

describe("navigation", () => {
  it("redirects / to the first screen the user may open", async () => {
    stubApi("owner");
    const { router } = renderApp(fixtures, "/");
    await screen.findByRole("heading", { level: 1, name: "Beta page" });
    expect(router.state.location.pathname).toBe("/beta");
  });

  it("redirects / to a different screen for a user with fewer levels", async () => {
    stubApi("reader");
    const { router } = renderApp(fixtures, "/");
    await screen.findByRole("heading", { level: 1, name: "Alpha list" });
    expect(router.state.location.pathname).toBe("/alpha");
  });

  it("lists only the features the user's levels allow, in order, in the sidebar", async () => {
    stubApi("reader");
    renderApp(fixtures, "/alpha");
    await screen.findByRole("heading", { level: 1, name: "Alpha list" });
    const links = sidebar().getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Alpha", "Delta"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/alpha", "/delta"]);
  });

  it("marks the current page and moves focus to the content after navigating", async () => {
    stubApi("owner");
    const user = userEvent.setup();
    renderApp(fixtures, "/beta");
    await screen.findByRole("heading", { level: 1, name: "Beta page" });
    await user.click(sidebar().getByRole("link", { name: "Alpha" }));
    await screen.findByRole("heading", { level: 1, name: "Alpha list" });
    expect(sidebar().getByRole("link", { name: "Alpha" })).toHaveAttribute("aria-current", "page");
    expect(sidebar().getByRole("link", { name: "Beta" })).not.toHaveAttribute("aria-current");
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  });

  it("loads feature pages lazily, including detail routes and back links", async () => {
    stubApi("owner");
    const user = userEvent.setup();
    renderApp(fixtures, "/alpha");
    await user.click(await screen.findByRole("link", { name: "Open item 42" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Alpha item 42" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Alpha list" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Alpha list" }),
    ).toBeInTheDocument();
  });

  it("serves features without a nav item by URL, but not in the navigation", async () => {
    stubApi("owner");
    renderApp(fixtures, "/hidden");
    await screen.findByRole("heading", { level: 1, name: "Hidden page" });
    expect(sidebar().queryByRole("link", { name: /hidden/i })).toBeNull();
  });

  it("shows a not-found page inside the shell for unknown addresses", async () => {
    stubApi("owner");
    renderApp(fixtures, "/nowhere/at/all");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(sidebar().getAllByRole("link").length).toBeGreaterThan(0);
  });

  it("has a skip link that moves focus to the content", async () => {
    stubApi("owner");
    const user = userEvent.setup();
    renderApp(fixtures, "/beta");
    await screen.findByRole("heading", { level: 1, name: "Beta page" });
    await user.click(screen.getByRole("link", { name: "Skip to content" }));
    expect(screen.getByRole("main")).toHaveFocus();
  });
});

describe("access control in the UI (cosmetic; the server enforces the real rule)", () => {
  it("shows a no-access message for a feature the user may not open by typing its URL, without loading it", async () => {
    stubApi("reader");
    renderApp(fixtures, "/beta");
    expect(await screen.findByText("You do not have access to this")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Beta page" })).toBeNull();
    expect(sidebar().queryByRole("link", { name: "Beta" })).toBeNull();
  });

  it("applies a requirement list as any-of", async () => {
    stubApi("collaborator"); // experiments=write, activity=read
    renderApp(fixtures, "/gamma");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Gamma page" }),
    ).toBeInTheDocument();
  });

  it("follows level changes made while the page is open: nav item and screen disappear", async () => {
    const api = stubApi("owner");
    const { client } = renderApp(fixtures, "/beta");
    await screen.findByRole("heading", { level: 1, name: "Beta page" });
    expect(sidebar().getByRole("link", { name: "Beta" })).toBeInTheDocument();

    api.setPersona("reader");
    await act(() => client.invalidateQueries({ queryKey: ME_QUERY_KEY }));
    await waitFor(() => expect(sidebar().queryByRole("link", { name: "Beta" })).toBeNull());
    expect(screen.getByText("You do not have access to this")).toBeInTheDocument();
  });

  it("drops to the access-not-granted page when an admin lowers everything", async () => {
    const api = stubApi("collaborator");
    const { client } = renderApp(fixtures, "/alpha");
    await screen.findByRole("heading", { level: 1, name: "Alpha list" });
    api.setPersona("newcomer");
    await act(() => client.invalidateQueries({ queryKey: ME_QUERY_KEY }));
    expect(
      await screen.findByRole("heading", { name: "Access not granted yet" }),
    ).toBeInTheDocument();
  });
});

describe("responsive navigation", () => {
  it("shows the first four items in the phone bar plus More, with the rest and sign-out in the sheet", async () => {
    stubApi("owner");
    const user = userEvent.setup();
    renderApp(manyFeatures, "/beta");
    await screen.findByRole("heading", { level: 1, name: "Beta page" });

    expect(
      bottomBar()
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Beta", "Alpha", "Gamma", "Epsilon"]);
    const more = bottomBar().getByRole("button", { name: "More" });
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(more);
    const sheet = within(await screen.findByRole("dialog", { name: "More" }));
    expect(sheet.getAllByRole("link").map((l) => l.textContent)).toEqual([
      "Zeta",
      "Delta",
      "Sign out",
    ]);
    expect(sheet.getByRole("link", { name: "Sign out" })).toHaveAttribute("href", "/auth/logout");
    expect(sheet.getByText("Channel Owner")).toBeInTheDocument();
  });

  it("closes the More sheet when a link in it is used", async () => {
    stubApi("owner");
    const user = userEvent.setup();
    const { router } = renderApp(manyFeatures, "/beta");
    await screen.findByRole("heading", { level: 1, name: "Beta page" });
    await user.click(bottomBar().getByRole("button", { name: "More" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("link", { name: "Zeta" }));
    await screen.findByRole("heading", { level: 1, name: "zeta page" });
    expect(router.state.location.pathname).toBe("/zeta");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps More available (for sign-out) even when everything fits in the bar", async () => {
    stubApi("reader");
    const user = userEvent.setup();
    renderApp(fixtures, "/alpha");
    await screen.findByRole("heading", { level: 1, name: "Alpha list" });
    expect(
      bottomBar()
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Alpha", "Delta"]);
    await user.click(bottomBar().getByRole("button", { name: "More" }));
    expect(
      within(await screen.findByRole("dialog")).getByRole("link", { name: "Sign out" }),
    ).toBeInTheDocument();
  });

  it("every navigation target is at least 44 px (class check; sizes are asserted in a browser by T51)", async () => {
    stubApi("owner");
    renderApp(fixtures, "/beta");
    await screen.findByRole("heading", { level: 1, name: "Beta page" });
    for (const link of sidebar().getAllByRole("link")) {
      expect(link.className).toContain("min-h-11");
    }
    for (const link of bottomBar().getAllByRole("link")) {
      expect(link.className).toContain("min-h-14");
    }
  });
});

describe("account block and banners", () => {
  it("shows who is signed in, marks admins and links to sign out", async () => {
    stubApi("owner");
    renderApp(fixtures, "/beta");
    await screen.findByRole("heading", { level: 1, name: "Beta page" });
    const aside = within(document.querySelector("aside") as HTMLElement);
    expect(aside.getByText("Channel Owner")).toBeInTheDocument();
    expect(aside.getByText("owner@example.test")).toBeInTheDocument();
    expect(aside.getByText("Admin")).toBeInTheDocument();
    expect(aside.getByRole("link", { name: "Sign out" })).toHaveAttribute("href", "/auth/logout");
  });

  it("does not mark non-admins", async () => {
    stubApi("reader");
    renderApp(fixtures, "/alpha");
    await screen.findByRole("heading", { level: 1, name: "Alpha list" });
    expect(within(document.querySelector("aside") as HTMLElement).queryByText("Admin")).toBeNull();
  });

  it("announces being offline and goes away on reconnect", async () => {
    stubApi("owner");
    renderApp(fixtures, "/beta");
    await screen.findByRole("heading", { level: 1, name: "Beta page" });
    expect(screen.queryByText(/You are offline/)).toBeNull();
    act(() => setOnline(false));
    expect(screen.getByRole("status")).toHaveTextContent(/You are offline/);
    act(() => setOnline(true));
    expect(screen.queryByText(/You are offline/)).toBeNull();
  });
});

describe("errors inside a screen", () => {
  it("renders the error inside the shell so the navigation survives", async () => {
    stubApi("owner");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = defineFeature({
      id: "broken",
      requires: "authenticated",
      nav: { label: "Broken", icon: Star, order: 5 },
      routes: [
        {
          path: "broken",
          Component: () => {
            throw new Error("kaboom");
          },
        },
      ],
    });
    renderApp([...fixtures, broken], "/broken");
    expect(
      await screen.findByRole("heading", { name: "This page could not be shown" }),
    ).toBeInTheDocument();
    expect(screen.getByText("kaboom")).toBeInTheDocument();
    expect(sidebar().getByRole("link", { name: "Alpha" })).toBeInTheDocument();
  });

  it("shows a message when a lazy page's code fails to load", async () => {
    stubApi("owner");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const flaky = defineFeature({
      id: "flaky",
      requires: "authenticated",
      routes: [
        {
          path: "flaky",
          lazy: () => Promise.reject(new Error("Failed to fetch dynamically imported module")),
        },
      ],
    });
    renderApp([...fixtures, flaky], "/flaky");
    expect(
      await screen.findByRole("heading", { name: "This page could not be shown" }),
    ).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("has no violations in the shell with a page", async () => {
    stubApi("owner");
    const { container } = renderApp(manyFeatures, "/alpha");
    await screen.findByRole("heading", { level: 1, name: "Alpha list" });
    await expectNoA11yViolations(container);
  });

  it("has no violations on the full-page states", async () => {
    stubApi("newcomer");
    const denied = renderApp(fixtures, "/alpha");
    await screen.findByRole("heading", { name: "Access not granted yet" });
    await expectNoA11yViolations(denied.container);
    denied.unmount();

    stubApi("anonymous");
    const accessDenied = renderApp(fixtures, "/access-denied");
    await screen.findByRole("heading", { name: "Access denied" });
    await expectNoA11yViolations(accessDenied.container);
  });
});
