import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { Pool } from "pg";
import {
  issuer,
  prepareIdentityProvider,
  removeUserFromAccessGroup,
  restoreIdentityProvider,
} from "../src/idp.js";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const mcpURL = process.env.E2E_MCP_URL ?? "http://127.0.0.1:3001/mcp";
const owner = {
  username: process.env.E2E_OWNER_USERNAME ?? "owner",
  password: process.env.E2E_OWNER_PASSWORD ?? "owner-dev-pass",
};
const collaborator = {
  username: process.env.E2E_COLLABORATOR_USERNAME ?? "collaborator",
  password: process.env.E2E_COLLABORATOR_PASSWORD ?? "collaborator-dev-pass",
};
const outsider = {
  username: process.env.E2E_OUTSIDER_USERNAME ?? "outsider",
  password: process.env.E2E_OUTSIDER_PASSWORD ?? "outsider-dev-pass",
};

interface UserRow {
  id: string;
  is_admin: boolean;
  access_revoked_at: Date | null;
}

interface ApiMe {
  user: { id: string; username: string; isAdmin: boolean };
  levels: Record<string, string>;
}

let database: Pool | undefined;

test.beforeAll(async () => {
  const connectionString = process.env.E2E_DATABASE_URL;
  if (connectionString === undefined) throw new Error("E2E_DATABASE_URL is required");
  database = new Pool({ connectionString });
  await prepareIdentityProvider();
});

test.afterAll(async () => {
  try {
    await restoreIdentityProvider();
  } finally {
    await database?.end();
  }
});

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${baseURL}/`);
  const usernameField = page.locator('input[name="username"]');
  await expect(usernameField).toBeVisible({ timeout: 60_000 });
  await usernameField.fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
}

async function userRow(username: string): Promise<UserRow | null> {
  if (database === undefined) throw new Error("Database pool was not initialized");
  const result = await database.query<UserRow>(
    "SELECT id::text, is_admin, access_revoked_at FROM public.users WHERE oidc_issuer = $1 AND username = $2",
    [issuer, username],
  );
  return result.rows[0] ?? null;
}

async function readMe(context: BrowserContext): Promise<{ status: number; body?: ApiMe }> {
  const response = await context.request.get(`${baseURL}/api/me`);
  if (!response.ok()) return { status: response.status() };
  return { status: response.status(), body: (await response.json()) as ApiMe };
}

test("OIDC access, admin grants, logout, and a UI-created MCP token", async ({ browser }) => {
  test.setTimeout(120_000);

  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const outsiderContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const collaboratorContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ownerPage = await ownerContext.newPage();
  const outsiderPage = await outsiderContext.newPage();
  const collaboratorPage = await collaboratorContext.newPage();

  try {
    await test.step("The first in-group sign-in becomes the admin", async () => {
      await signIn(ownerPage, owner.username, owner.password);
      await expect.poll(async () => (await readMe(ownerContext)).status).toBe(200);
      const session = await readMe(ownerContext);
      expect(session.body?.user.isAdmin).toBe(true);
      const row = await userRow(owner.username);
      expect(row?.is_admin).toBe(true);
    });

    await test.step("An outsider is denied without creating a user row", async () => {
      await signIn(outsiderPage, outsider.username, outsider.password);
      await expect(outsiderPage.getByRole("heading", { name: "Access denied" })).toBeVisible();
      expect(await userRow(outsider.username)).toBeNull();
    });

    let collaboratorId = "";
    await test.step("A second in-group user starts with no access", async () => {
      await signIn(collaboratorPage, collaborator.username, collaborator.password);
      await expect(
        collaboratorPage.getByRole("heading", { name: "Access not granted yet" }),
      ).toBeVisible();
      const row = await userRow(collaborator.username);
      if (row === null) throw new Error("The in-group collaborator was not persisted");
      collaboratorId = row.id;
      expect(row.is_admin).toBe(false);
    });

    await test.step("The admin grants access through the settings matrix", async () => {
      await ownerPage.goto(`${baseURL}/settings`);
      await expect(ownerPage.getByRole("heading", { name: "Settings" })).toBeVisible();
      const ideasAccess = ownerPage.getByRole("combobox", {
        name: `${collaborator.username}: Ideas`,
      });
      const ideasResponse = ownerPage.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          response.url().includes(`/api/settings/users/${collaboratorId}/permissions`),
      );
      await ideasAccess.selectOption("read");
      expect((await ideasResponse).ok()).toBe(true);

      const scriptsAccess = ownerPage.getByRole("combobox", {
        name: `${collaborator.username}: Scripts`,
      });
      const scriptsResponse = ownerPage.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          response.url().includes(`/api/settings/users/${collaboratorId}/permissions`),
      );
      await scriptsAccess.selectOption("write");
      expect((await scriptsResponse).ok()).toBe(true);

      await collaboratorPage.getByRole("button", { name: "Check again" }).click();
      await expect(
        collaboratorPage.getByRole("heading", { name: "Access not granted yet" }),
      ).toHaveCount(0);
      const me = await readMe(collaboratorContext);
      expect(me.status).toBe(200);
      expect(me.body?.levels.ideas).toBe("read");
      expect(me.body?.levels.scripts).toBe("write");
    });

    await test.step("Removing the Keycloak group ends access at the next refresh", async () => {
      await removeUserFromAccessGroup(collaborator.username);
      await expect
        .poll(async () => (await readMe(collaboratorContext)).status, {
          timeout: 60_000,
          intervals: [500, 1_000, 2_000],
        })
        .toBe(401);
      const row = await userRow(collaborator.username);
      expect(row?.access_revoked_at).not.toBeNull();
    });

    let tokenSecret = "";
    await test.step("The UI issues an API token that can call MCP", async () => {
      await ownerPage.goto(`${baseURL}/settings`);
      await expect(ownerPage.getByRole("heading", { name: "Settings" })).toBeVisible();
      await ownerPage.getByRole("button", { name: "Create token" }).click();
      const createDialog = ownerPage.getByRole("dialog", { name: "Create API token" });
      await createDialog.getByLabel("Token name").fill("T48 MCP reader");
      await createDialog.getByLabel("Ideas permission").selectOption("read");
      const createResponse = ownerPage.waitForResponse(
        (response) =>
          response.request().method() === "POST" && response.url().includes("/api/settings/tokens"),
      );
      await createDialog.getByRole("button", { name: "Create token" }).click();
      expect((await createResponse).ok()).toBe(true);

      const secretDialog = ownerPage.getByRole("dialog", { name: "Copy your API token" });
      await expect(secretDialog).toBeVisible();
      tokenSecret = (await secretDialog.locator("code").innerText()).trim();
      if (!tokenSecret.startsWith("ytw_")) throw new Error("The UI did not show an API token");
      await secretDialog.getByRole("button", { name: "I saved it" }).click();

      const transport = new StreamableHTTPClientTransport(new URL(mcpURL), {
        requestInit: { headers: { authorization: `Bearer ${tokenSecret}` } },
      });
      const client = new McpClient(
        { name: "youtube-workspace-e2e", version: "1.0.0" },
        { capabilities: {} },
      );
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.some((tool) => tool.name === "list_ideas")).toBe(true);
        const result = await client.callTool({ name: "list_ideas", arguments: {} });
        expect(result.isError).not.toBe(true);
      } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }
    });

    await test.step("RP logout also ends the identity-provider session", async () => {
      await ownerPage.goto(`${baseURL}/auth/logout`);
      await ownerPage.getByRole("button", { name: "Sign out" }).click();
      await expect(ownerPage.locator('input[name="username"]')).toBeVisible({ timeout: 30_000 });
    });
  } finally {
    await ownerContext.close();
    await outsiderContext.close();
    await collaboratorContext.close();
  }
});
