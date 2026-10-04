import { expect, test } from "@playwright/test";
import { prepareIdentityProvider, restoreIdentityProvider } from "../src/idp.js";
import { baseURL, createScript, mcpOrigin, mutation, signIn } from "./helpers.js";

test.beforeAll(prepareIdentityProvider);
test.afterAll(restoreIdentityProvider);

test("admin sets the user access matrix; changes immediately apply and token grants stop at owner access", async ({
  browser,
}) => {
  const admin = await browser.newContext();
  const member = await browser.newContext();
  try {
    const ownerPage = await admin.newPage();
    const memberPage = await member.newPage();
    await signIn(ownerPage);
    await signIn(memberPage, "collaborator");
    const me = (await (await member.request.get(`${baseURL}/api/me`)).json()) as {
      user: { id: string };
    };
    await ownerPage.goto(`${baseURL}/settings`);
    for (const [resource, level] of [
      ["Ideas", "write"],
      ["Scripts", "read"],
      ["Notes", "none"],
      ["Activity log", "none"],
    ]) {
      const request = ownerPage.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          response.url().includes(`/users/${me.user.id}/permissions`),
      );
      await ownerPage
        .getByRole("combobox", { name: `collaborator: ${resource}` })
        .selectOption(level ?? "none");
      expect((await request).status()).toBe(200);
    }
    expect((await member.request.get(`${baseURL}/api/ideas`)).status()).toBe(200);
    expect(
      (await mutation(member, "POST", "/api/ideas", { title: "Member can write" })).status(),
    ).toBe(201);
    expect((await mutation(member, "POST", "/api/scripts", {})).status()).toBe(403);
    expect((await member.request.get(`${baseURL}/api/notes`)).status()).toBe(403);
    expect((await member.request.get(`${baseURL}/api/settings/users`)).status()).toBe(403);
    await memberPage.goto(`${baseURL}/settings`);
    await memberPage.getByRole("button", { name: "Create token", exact: true }).click();
    const form = memberPage.getByRole("dialog", { name: "Create API token" });
    await expect(form.getByLabel("Scripts permission").locator("option")).toHaveText([
      "None",
      "Read",
    ]);
    await expect(form.getByLabel("Notes permission").locator("option")).toHaveText(["None"]);
    expect(
      (
        await mutation(member, "POST", "/api/settings/tokens", {
          name: "Excess access",
          permissions: { scripts: "write" },
        })
      ).status(),
    ).toBe(403);
    const readToken = await mutation(member, "POST", "/api/settings/tokens", {
      name: "Owner level test",
      permissions: { scripts: "read" },
    });
    expect(readToken.status()).toBe(201);
    const token = (await readToken.json()) as { secret: string };
    const seeded = await createScript(admin);
    const file = `${mcpOrigin}/files/scripts/${seeded.idea.id}/script`;
    expect(
      (
        await member.request.get(file, { headers: { authorization: `Bearer ${token.secret}` } })
      ).status(),
    ).toBe(200);
    const lowered = ownerPage.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().includes(`/users/${me.user.id}/permissions`),
    );
    await ownerPage.getByRole("combobox", { name: "collaborator: Scripts" }).selectOption("none");
    expect((await lowered).status()).toBe(200);
    expect((await member.request.get(`${baseURL}/api/scripts`)).status()).toBe(403);
    expect(
      (
        await member.request.get(file, { headers: { authorization: `Bearer ${token.secret}` } })
      ).status(),
    ).toBe(403);
  } finally {
    await admin.close();
    await member.close();
  }
});
