import { randomUUID } from "node:crypto";
import { expect, type Page, type BrowserContext, type APIResponse } from "@playwright/test";

export const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
export const mcpOrigin = new URL(process.env.E2E_MCP_URL ?? "http://127.0.0.1:3001/mcp").origin;
export const unique = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;

export async function signIn(page: Page, username = "owner"): Promise<void> {
  await page.goto(`${baseURL}/`);
  await expect(page.locator('input[name="username"]')).toBeVisible({ timeout: 60_000 });
  await page
    .locator('input[name="username"]')
    .fill(
      process.env[username === "owner" ? "E2E_OWNER_USERNAME" : "E2E_COLLABORATOR_USERNAME"] ??
        username,
    );
  await page
    .locator('input[name="password"]')
    .fill(
      process.env[username === "owner" ? "E2E_OWNER_PASSWORD" : "E2E_COLLABORATOR_PASSWORD"] ??
        `${username}-dev-pass`,
    );
  await page.locator('button[type="submit"]').click();
  await expect.poll(async () => (await page.request.get(`${baseURL}/api/me`)).status()).toBe(200);
}

export async function mutation(
  context: BrowserContext,
  method: string,
  path: string,
  data?: unknown,
): Promise<APIResponse> {
  const me = await context.request.get(`${baseURL}/api/me`);
  expect(me.status()).toBe(200);
  const csrf = me.headers()["x-csrf-token"];
  if (!csrf) throw new Error("Signed-in session did not provide a CSRF token");
  return context.request.fetch(`${baseURL}${path}`, {
    method,
    headers: { "x-csrf-token": csrf, origin: baseURL },
    ...(data === undefined ? {} : { data }),
  });
}

export async function createIdea(context: BrowserContext, title = unique("Gate idea")) {
  const response = await mutation(context, "POST", "/api/ideas", {
    title,
    pitch: "Gate story pitch",
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { idea: { id: string; title: string; version: number } }).idea;
}

export async function createScript(
  context: BrowserContext,
  body = "# Phone script\n\nRead this comfortably.",
) {
  const idea = await createIdea(context);
  const response = await mutation(context, "POST", "/api/scripts", {
    idea_id: idea.id,
    kind: "script",
    base_version: 0,
    body_md: body,
  });
  expect(response.status()).toBe(201);
  const { script } = (await response.json()) as { script: { id: string; version: number } };
  return { idea, script, path: `/scripts/${idea.id}/script` };
}

export async function createToken(page: Page, name: string, permission = "write") {
  await page.goto(`${baseURL}/settings`);
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Create API token" });
  await form.getByLabel("Token name").fill(name);
  await form.getByLabel("Scripts permission").selectOption(permission);
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings/tokens") && response.request().method() === "POST",
  );
  await form.getByRole("button", { name: "Create token", exact: true }).click();
  expect((await created).status()).toBe(201);
  const dialog = page.getByRole("dialog", { name: "Copy your API token" });
  const secret = (await dialog.locator("code").textContent())?.trim();
  if (!secret) throw new Error("Token secret was not displayed once");
  await dialog.getByRole("button", { name: "I saved it" }).click();
  const listed = await page.request.get(`${baseURL}/api/settings/tokens`);
  const { tokens } = (await listed.json()) as {
    tokens: { id: string; name: string; expires_at: string | null }[];
  };
  const token = tokens.find((item) => item.name === name);
  if (!token) throw new Error("Created token missing from own token list");
  return { ...token, secret };
}
