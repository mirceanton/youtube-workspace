import { expect, test } from "@playwright/test";
import { prepareIdentityProvider, restoreIdentityProvider } from "../src/idp.js";
import {
  baseURL,
  createIdea,
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

test("owner drags an idea forward and backward moves require a note", async ({ page, context }) => {
  const idea = await createIdea(context);
  await page.goto(`${baseURL}/ideas`);
  await page
    .getByRole("button", { name: `Drag ${idea.title} to another stage` })
    .dragTo(page.getByRole("region", { name: "Shortlisted ideas", exact: true }), {
      targetPosition: { x: 20, y: 20 },
    });
  const dialog = page.getByRole("dialog", { name: "Move idea to another stage" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Move idea", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Shortlisted ideas", exact: true })
      .getByRole("link", { name: idea.title }),
  ).toBeVisible();
  const latest = await context.request.get(`${baseURL}/api/ideas/${idea.id}`);
  const { idea: moved } = (await latest.json()) as {
    idea: { version: number; status: string; updated_by: string };
  };
  expect(moved.status).toBe("shortlisted");
  expect(moved.updated_by).toBe("owner");
  const missingNote = await mutation(context, "POST", `/api/ideas/${idea.id}/stage`, {
    expected_version: moved.version,
    new_status: "inbox",
  });
  expect(missingNote.status()).toBe(400);
  await page
    .getByRole("region", { name: "Shortlisted ideas", exact: true })
    .getByRole("link", { name: idea.title })
    .click();
  await expect(page.getByRole("heading", { name: idea.title, exact: true })).toBeVisible();
});

test("owner reads a script and leaves a comment at phone width", async ({ page, context }) => {
  const seeded = await createScript(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseURL}${seeded.path}`);
  await expect(page.getByRole("heading", { name: "Phone script", exact: true })).toBeVisible();
  await expect(page.getByText("Read this comfortably.", { exact: true })).toBeVisible();
  const comment = unique("Please tighten the introduction");
  await page.getByLabel("Add to comments").fill(comment);
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.getByText("Note added.", { exact: true })).toBeVisible();
  await expect(page.getByText(comment, { exact: true })).toBeVisible();
  const notes = await context.request.get(
    `${baseURL}/api/notes?entity_type=script&entity_id=${seeded.script.id}`,
  );
  const payload = (await notes.json()) as {
    notes: { body_md: string; author: string; actor_type: string }[];
  };
  expect(payload.notes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ body_md: comment, author: "owner", actor_type: "human" }),
    ]),
  );
});

test("owner compares CTR and impressions and chooses an experiment winner", async ({
  page,
  context,
}) => {
  const videoResponse = await mutation(context, "POST", "/api/videos", {
    youtube_id: "gatevideo01",
    title: unique("Comparison video"),
  });
  expect(videoResponse.status()).toBe(201);
  const { video } = (await videoResponse.json()) as { video: { id: string } };
  const created = await mutation(context, "POST", "/api/experiments", {
    video_id: video.id,
    type: "title",
    hypothesis: "Specific titles improve CTR",
    variants: [
      { label: "Control A", content: "A general title", is_control: true },
      { label: "Specific B", content: "A specific title" },
    ],
  });
  expect(created.status()).toBe(201);
  const { experiment } = (await created.json()) as {
    experiment: { id: string; variants: { id: string }[] };
  };
  for (const [index, variant] of experiment.variants.entries()) {
    const stats = await mutation(
      context,
      "PATCH",
      `/api/experiments/${experiment.id}/variants/${variant.id}/stats`,
      { impressions: "12000", ctr: index === 0 ? "4.5" : "6.5" },
    );
    expect(stats.status()).toBe(200);
  }
  await page.goto(`${baseURL}/experiments/${experiment.id}`);
  await expect(page.getByRole("heading", { name: "Control A", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Specific B", exact: true })).toBeVisible();
  await expect(page.getByText("4.50%", { exact: true })).toBeVisible();
  await expect(page.getByText("6.50%", { exact: true })).toBeVisible();
  await expect(page.getByText("12000", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Start experiment" }).click();
  await page.getByLabel("Winning variant").selectOption({ label: "Specific B" });
  await page
    .getByRole("textbox", { name: /^Conclusion/ })
    .fill("Specific B wins with two percentage points higher CTR.");
  await page.getByRole("button", { name: "Save conclusion" }).click();
  await expect(page.getByText("Winner", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Specific B wins with two percentage points higher CTR.", { exact: true }),
  ).toBeVisible();
});

test("agent downloads markdown and appends a revision; stale upload cannot overwrite", async ({
  page,
  context,
}) => {
  const seeded = await createScript(context, "# Round trip\n\nOriginal script.");
  const token = await createToken(page, unique("Roundtrip agent"));
  const headers = { authorization: `Bearer ${token.secret}` };
  const path = `${mcpOrigin}/files/scripts/${seeded.idea.id}/script`;
  const downloaded = await context.request.get(path, { headers });
  expect(downloaded.status()).toBe(200);
  const markdown = await downloaded.text();
  expect(markdown).toContain("version: 1");
  const uploaded = await context.request.put(path, {
    headers: { ...headers, "content-type": "text/markdown" },
    data: markdown.replace("Original script.", "Agent revised script."),
  });
  expect(uploaded.status()).toBe(201);
  const stale = await context.request.put(path, {
    headers: { ...headers, "content-type": "text/markdown" },
    data: markdown.replace("Original script.", "Stale overwrite."),
  });
  expect(stale.status()).toBe(409);
  await page.goto(`${baseURL}${seeded.path}`);
  await expect(page.getByText("Agent revised script.", { exact: true })).toBeVisible();
  await expect(page.getByText("Version 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Stale overwrite.", { exact: true })).toHaveCount(0);
});

test("owner creates a token once and revocation immediately ends MCP access", async ({
  page,
  context,
  request,
}) => {
  const seeded = await createScript(context);
  const token = await createToken(page, unique("Revocation agent"), "read");
  expect(token.expires_at).not.toBeNull();
  const expiry = Date.parse(token.expires_at ?? "");
  expect(expiry - Date.now()).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
  const path = `${mcpOrigin}/files/scripts/${seeded.idea.id}/script`;
  // The API request fixture has no browser cookies: an MCP bearer secret cannot log in.
  expect(
    (
      await request.get(`${baseURL}/api/me`, {
        headers: { authorization: `Bearer ${token.secret}` },
      })
    ).status(),
  ).toBe(401);
  expect(
    await page.evaluate<{ local: number; session: number }>(
      "({ local: localStorage.length, session: sessionStorage.length })",
    ),
  ).toEqual({ local: 0, session: 0 });
  expect(
    (
      await context.request.get(path, { headers: { authorization: `Bearer ${token.secret}` } })
    ).status(),
  ).toBe(200);
  await page.goto(`${baseURL}/settings/tokens/${token.id}`);
  await expect(page.locator("code")).toHaveCount(0);
  await page.getByRole("button", { name: "Revoke token", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Revoke this token?" })
    .getByRole("button", { name: "Revoke token", exact: true })
    .click();
  await expect(page.getByText("revoked", { exact: true })).toBeVisible();
  expect(
    (
      await context.request.get(path, { headers: { authorization: `Bearer ${token.secret}` } })
    ).status(),
  ).toBe(401);
});

test("two browser sessions keep the losing script draft and allow reloading the winner", async ({
  page,
  context,
  browser,
}) => {
  const seeded = await createScript(context, "# Conflict\n\nBase draft.");
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await signIn(other);
    await page.goto(`${baseURL}${seeded.path}`);
    await other.goto(`${baseURL}${seeded.path}`);
    await page.getByRole("button", { name: "Edit latest version" }).click();
    await other.getByRole("button", { name: "Edit latest version" }).click();
    await page.getByLabel("Markdown source").fill("# Conflict\n\nWinning draft.");
    await other.getByLabel("Markdown source").fill("# Conflict\n\nUnsaved losing draft.");
    await page.getByRole("button", { name: "Save new version" }).click();
    await expect(page.getByText("Winning draft.", { exact: true })).toBeVisible();
    await other.getByRole("button", { name: "Save new version" }).click();
    const conflict = other.getByRole("dialog", {
      name: "This script changed while you were editing",
    });
    await expect(conflict).toBeVisible();
    await expect(conflict.getByText("Unsaved losing draft.", { exact: true })).toBeVisible();
    await conflict.getByRole("button", { name: "Keep editing" }).click();
    await expect(other.getByLabel("Markdown source")).toHaveValue(
      "# Conflict\n\nUnsaved losing draft.",
    );
    await other.getByRole("button", { name: "Save new version" }).click();
    await conflict.getByRole("button", { name: "Discard mine and reload" }).click();
    await expect(other.getByText("Winning draft.", { exact: true })).toBeVisible();
    const versions = await context.request.get(
      `${baseURL}/api/scripts/history?idea_id=${seeded.idea.id}&kind=script`,
    );
    expect(((await versions.json()) as { versions: unknown[] }).versions).toHaveLength(2);
  } finally {
    await otherContext.close();
  }
});
