import { expect, test } from "@playwright/test";
import { RESOURCES } from "@ytw/shared/constants";
import { prepareIdentityProvider, restoreIdentityProvider } from "../src/idp.js";
import {
  baseURL,
  createScript,
  createToken,
  mcpOrigin,
  mutation,
  signIn,
  unique,
} from "./helpers.js";

test.beforeAll(prepareIdentityProvider);
test.afterAll(restoreIdentityProvider);
test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("owner sees who changed a script and when, with human and agent audit filters", async ({
  page,
  context,
}) => {
  const seeded = await createScript(context, "# Audit script\n\nHuman draft.");
  const token = await createToken(page, unique("Audit agent"));
  const upload = await context.request.put(
    `${mcpOrigin}/files/scripts/${seeded.idea.id}/script?base_version=1`,
    {
      headers: { authorization: `Bearer ${token.secret}`, "content-type": "text/markdown" },
      data: "# Audit script\n\nAgent draft.",
    },
  );
  expect(upload.status()).toBe(201);
  const revision = (await upload.json()) as { id: string };
  await page.goto(`${baseURL}/activity`);
  await page.getByLabel("Entity type", { exact: true }).selectOption("script");
  await page.getByLabel("Actor type", { exact: true }).selectOption("human");
  await page.getByLabel("Entity ID", { exact: true }).fill(seeded.script.id);
  const humanEvent = page.locator("li").filter({ hasText: seeded.script.id });
  await expect(humanEvent.getByText("owner", { exact: true })).toBeVisible();
  await expect(humanEvent.getByText("Human", { exact: true })).toBeVisible();
  await expect(humanEvent.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
  await page.getByLabel("Actor type", { exact: true }).selectOption("agent");
  await page.getByLabel("Entity ID", { exact: true }).fill(revision.id);
  await page.getByLabel("Actor", { exact: true }).fill(token.name);
  const agentEvents = page.locator("li").filter({ hasText: revision.id });
  await expect(agentEvents.getByText(token.name, { exact: true }).first()).toBeVisible();
  await expect(agentEvents.getByText("Agent", { exact: true }).first()).toBeVisible();
  await expect(agentEvents.locator("time").first()).toHaveAttribute(
    "datetime",
    /^\d{4}-\d{2}-\d{2}T/,
  );
  const feed = await context.request.get(
    `${baseURL}/api/activity?actor=${encodeURIComponent(token.name)}&entity_type=script&entity_id=${revision.id}`,
  );
  const { events } = (await feed.json()) as {
    events: { token_id: string; actor_type: string; payload: Record<string, unknown> }[];
  };
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((event) => event.token_id === token.id && event.actor_type === "agent")).toBe(
    true,
  );
  expect(events.some((event) => JSON.stringify(event.payload).includes("owner"))).toBe(true);
});

test("MCP revision appears in an already-open phone reader within 15 seconds without navigation", async ({
  page,
  context,
}) => {
  const seeded = await createScript(context, "# Live script\n\nOriginal content.");
  const token = await createToken(page, unique("Live agent"));
  const file = `${mcpOrigin}/files/scripts/${seeded.idea.id}/script`;
  const headers = { authorization: `Bearer ${token.secret}` };
  const exported = await context.request.get(file, { headers });
  expect(exported.status()).toBe(200);
  const markdown = await exported.text();
  await page.setViewportSize({ width: 390, height: 844 });
  const firstPoll = page.waitForResponse(
    (response) => response.url().includes("/api/activity/changes") && response.status() === 200,
  );
  await page.goto(`${baseURL}${seeded.path}`);
  await firstPoll;
  await expect(page.getByText("Original content.", { exact: true })).toBeVisible();
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  const started = Date.now();
  const updated = await context.request.put(file, {
    headers: { ...headers, "content-type": "text/markdown" },
    data: markdown.replace("Original content.", "Agent content appears live."),
  });
  expect(updated.status()).toBe(201);
  await expect(page.getByText("Agent content appears live.", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThanOrEqual(15_000);
  console.info(`[gate] MCP revision visible without reload in ${elapsed} ms`);
  expect(navigations).toBe(0);
  await expect(page.getByText("Version 2", { exact: true })).toBeVisible();
});

test("a reader without activity access sees no audit data; search returns only readable resources", async ({
  context,
  browser,
}) => {
  const seedTerm = `gateprivacy${Date.now()}`;
  const seeded = await createScript(
    context,
    `# Restricted script\n\n${seedTerm} <img src=x onerror="window.gateXss=true">`,
  );
  expect(
    (
      await mutation(context, "PATCH", `/api/ideas/${seeded.idea.id}`, {
        expected_version: seeded.idea.version,
        title: `${seedTerm} private idea`,
      })
    ).status(),
  ).toBe(200);
  const member = await browser.newContext();
  try {
    const memberPage = await member.newPage();
    await signIn(memberPage, "collaborator");
    const me = (await (await member.request.get(`${baseURL}/api/me`)).json()) as {
      user: { id: string };
    };
    for (const resource of RESOURCES) {
      expect(
        (
          await mutation(context, "PATCH", `/api/settings/users/${me.user.id}/permissions`, {
            resource,
            level: resource === "scripts" ? "read" : "none",
          })
        ).status(),
      ).toBe(200);
    }
    expect((await member.request.get(`${baseURL}/api/activity`)).status()).toBe(403);
    const dashboard = await member.request.get(`${baseURL}/api/dashboard`);
    expect(dashboard.status()).toBe(200);
    const summary = (await dashboard.json()) as Record<string, unknown>;
    expect(summary.recent_activity).toBeNull();
    expect(summary.ideas).toBeNull();
    expect(summary.running_experiments).toBeNull();
    expect(summary.latest_videos).toBeNull();
    const changes = await member.request.get(`${baseURL}/api/activity/changes`);
    expect(changes.status()).toBe(200);
    expect(Object.keys((await changes.json()) as object).toSorted()).toEqual([
      "changed_resources",
      "cursor",
      "has_more",
    ]);
    await memberPage.goto(`${baseURL}/activity`);
    await expect(memberPage.getByRole("heading", { name: "Activity", exact: true })).toHaveCount(0);
    await expect(memberPage.getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);
    const found = await member.request.get(`${baseURL}/api/search?q=${seedTerm}`);
    expect(found.status()).toBe(200);
    const { results } = (await found.json()) as {
      results: { entity_type: string; title: string | null }[];
    };
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every((result) => result.entity_type === "script" && result.title === null),
    ).toBe(true);
    await memberPage.goto(`${baseURL}/search`);
    await memberPage.getByLabel("Search the workspace").fill(seedTerm);
    await memberPage.getByRole("button", { name: "Search", exact: true }).click();
    await expect(memberPage.getByRole("link", { name: "Script · version 1" })).toBeVisible();
    await expect(memberPage.locator("main img")).toHaveCount(0);
    expect(await memberPage.evaluate(() => "gateXss" in globalThis)).toBe(false);
    await expect(memberPage.getByText(`${seedTerm} private idea`, { exact: true })).toHaveCount(0);
    // Read access to notes alone does not authorize global search over ideas/scripts.
    expect(
      (
        await mutation(context, "PATCH", `/api/settings/users/${me.user.id}/permissions`, {
          resource: "notes",
          level: "read",
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await mutation(context, "PATCH", `/api/settings/users/${me.user.id}/permissions`, {
          resource: "scripts",
          level: "none",
        })
      ).status(),
    ).toBe(200);
    expect((await member.request.get(`${baseURL}/api/search?q=${seedTerm}`)).status()).toBe(403);
  } finally {
    await member.close();
  }
});
