import { randomUUID } from "node:crypto";
import { RESOURCES, type Resource } from "@ytw/shared/constants";
import { expect, test, type BrowserContext } from "@playwright/test";
import { prepareIdentityProvider, restoreIdentityProvider } from "../src/idp.js";
import { baseURL, createScript, mutation, signIn } from "./helpers.js";

interface RouteCase {
  method: string;
  path: string;
  required: "read" | "write" | "any" | "admin";
  resource?: Resource;
  /** Denied callers must fail before input validation; authorized invalid probes reach 400/404. */
  allowed: number;
}

test.beforeAll(prepareIdentityProvider);
test.afterAll(restoreIdentityProvider);

test("every feature API route enforces None, Read and Write with current database permissions", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await browser.newContext();
  const member = await browser.newContext();
  const anonymous = await browser.newContext();
  try {
    await signIn(await owner.newPage());
    await signIn(await member.newPage(), "collaborator");
    const me = (await (await member.request.get(`${baseURL}/api/me`)).json()) as {
      user: { id: string };
    };
    const seeded = await createScript(owner);
    const missing = randomUUID();
    const routes: RouteCase[] = [
      { method: "GET", path: "/api/me", required: "any", allowed: 200 },
      { method: "GET", path: "/api/dashboard", required: "any", allowed: 200 },
      {
        method: "GET",
        path: "/api/activity",
        resource: "activity",
        required: "read",
        allowed: 200,
      },
      { method: "GET", path: "/api/activity/changes", required: "any", allowed: 200 },
      { method: "GET", path: "/api/search?q=Gate", required: "any", allowed: 200 },
      { method: "GET", path: "/api/ideas", resource: "ideas", required: "read", allowed: 200 },
      {
        method: "GET",
        path: `/api/ideas/${seeded.idea.id}`,
        resource: "ideas",
        required: "read",
        allowed: 200,
      },
      { method: "POST", path: "/api/ideas", resource: "ideas", required: "write", allowed: 400 },
      {
        method: "PATCH",
        path: `/api/ideas/${seeded.idea.id}`,
        resource: "ideas",
        required: "write",
        allowed: 400,
      },
      {
        method: "POST",
        path: `/api/ideas/${seeded.idea.id}/stage`,
        resource: "ideas",
        required: "write",
        allowed: 400,
      },
      {
        method: "POST",
        path: `/api/ideas/${seeded.idea.id}/archive`,
        resource: "ideas",
        required: "write",
        allowed: 400,
      },
      { method: "GET", path: "/api/scripts", resource: "scripts", required: "read", allowed: 200 },
      {
        method: "GET",
        path: `/api/scripts/history?idea_id=${seeded.idea.id}&kind=script`,
        resource: "scripts",
        required: "read",
        allowed: 200,
      },
      {
        method: "GET",
        path: `/api/scripts/${seeded.script.id}`,
        resource: "scripts",
        required: "read",
        allowed: 200,
      },
      {
        method: "GET",
        path: `/api/scripts/${seeded.script.id}/file`,
        resource: "scripts",
        required: "read",
        allowed: 200,
      },
      {
        method: "POST",
        path: "/api/scripts",
        resource: "scripts",
        required: "write",
        allowed: 400,
      },
      {
        method: "PATCH",
        path: `/api/scripts/${seeded.script.id}/status`,
        resource: "scripts",
        required: "write",
        allowed: 400,
      },
      {
        method: "POST",
        path: "/api/scripts/upload",
        resource: "scripts",
        required: "write",
        allowed: 400,
      },
      { method: "GET", path: "/api/videos", resource: "videos", required: "read", allowed: 200 },
      {
        method: "GET",
        path: `/api/videos/${missing}`,
        resource: "videos",
        required: "read",
        allowed: 404,
      },
      { method: "POST", path: "/api/videos", resource: "videos", required: "write", allowed: 400 },
      {
        method: "PATCH",
        path: `/api/videos/${missing}`,
        resource: "videos",
        required: "write",
        allowed: 400,
      },
      {
        method: "GET",
        path: "/api/experiments",
        resource: "experiments",
        required: "read",
        allowed: 200,
      },
      {
        method: "GET",
        path: "/api/experiments/videos",
        resource: "experiments",
        required: "write",
        allowed: 200,
      },
      {
        method: "GET",
        path: `/api/experiments/${missing}`,
        resource: "experiments",
        required: "read",
        allowed: 404,
      },
      {
        method: "GET",
        path: `/api/experiments/${missing}/ctr-history`,
        resource: "experiments",
        required: "read",
        allowed: 404,
      },
      {
        method: "POST",
        path: "/api/experiments",
        resource: "experiments",
        required: "write",
        allowed: 400,
      },
      {
        method: "PATCH",
        path: `/api/experiments/${missing}/status`,
        resource: "experiments",
        required: "write",
        allowed: 400,
      },
      {
        method: "PATCH",
        path: `/api/experiments/${missing}/variants/${missing}/stats`,
        resource: "experiments",
        required: "write",
        allowed: 400,
      },
      {
        method: "POST",
        path: `/api/experiments/${missing}/conclude`,
        resource: "experiments",
        required: "write",
        allowed: 400,
      },
      {
        method: "GET",
        path: `/api/notes?entity_type=script&entity_id=${seeded.script.id}`,
        resource: "notes",
        required: "read",
        allowed: 200,
      },
      { method: "POST", path: "/api/notes", resource: "notes", required: "write", allowed: 400 },
      { method: "GET", path: "/api/settings/profile", required: "any", allowed: 200 },
      { method: "GET", path: "/api/settings/tokens", required: "any", allowed: 200 },
      { method: "POST", path: "/api/settings/tokens", required: "any", allowed: 400 },
      { method: "PATCH", path: `/api/settings/tokens/${missing}`, required: "any", allowed: 400 },
      {
        method: "POST",
        path: `/api/settings/tokens/${missing}/rotate`,
        required: "any",
        allowed: 404,
      },
      { method: "DELETE", path: `/api/settings/tokens/${missing}`, required: "any", allowed: 404 },
      { method: "GET", path: "/api/settings/users", required: "admin", allowed: 403 },
      {
        method: "PATCH",
        path: `/api/settings/users/${me.user.id}/permissions`,
        required: "admin",
        allowed: 403,
      },
      {
        method: "PATCH",
        path: `/api/settings/users/${me.user.id}/admin`,
        required: "admin",
        allowed: 403,
      },
    ];
    for (const level of ["none", "read", "write"] as const) {
      for (const resource of RESOURCES) {
        const response = await mutation(
          owner,
          "PATCH",
          `/api/settings/users/${me.user.id}/permissions`,
          { resource, level: resource === "activity" && level === "write" ? "read" : level },
        );
        expect(response.status()).toBe(200);
      }
      for (const route of routes) {
        await test.step(`${level}: ${route.method} ${route.path}`, async () => {
          const allowed =
            route.path === "/api/me" ||
            (route.required === "admin"
              ? false
              : route.required === "write"
                ? level === "write"
                : level !== "none");
          const response = await requestRoute(member, route);
          expect(response.status()).toBe(allowed ? route.allowed : 403);
        });
      }
    }
    for (const route of routes) {
      const response = await anonymous.request.fetch(`${baseURL}${route.path}`, {
        method: route.method,
        ...(route.method === "GET" ? {} : { data: {} }),
      });
      expect(response.status(), `Anonymous ${route.method} ${route.path}`).toBe(401);
    }
    // Orthogonal permissions: experiment access cannot expose the video's CTR series or choices.
    expect(
      (
        await mutation(owner, "PATCH", `/api/settings/users/${me.user.id}/permissions`, {
          resource: "videos",
          level: "none",
        })
      ).status(),
    ).toBe(200);
    for (const path of ["/api/experiments/videos", `/api/experiments/${missing}/ctr-history`]) {
      expect((await member.request.get(`${baseURL}${path}`)).status()).toBe(403);
    }
  } finally {
    await owner.close();
    await member.close();
    await anonymous.close();
  }
});

async function requestRoute(context: BrowserContext, route: RouteCase) {
  if (route.method === "GET") return context.request.get(`${baseURL}${route.path}`);
  return mutation(context, route.method, route.path, {});
}
