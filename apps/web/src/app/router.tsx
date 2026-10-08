import { createBrowserRouter, type RouteObject } from "react-router";
import { RequireAccess } from "@/kit/RequireAccess.tsx";
import { ACCESS_DENIED_PATH } from "@/lib/contract.ts";
import { AppShell } from "./AppShell.tsx";
import type { FeatureDefinition } from "./features.ts";
import { HomeRedirect } from "./HomeRedirect.tsx";
import { AccessDeniedPage, HydrateFallback, NotFoundPage, RouteErrorPage } from "./pages.tsx";
import { SessionGate } from "./SessionGate.tsx";

/**
 * The route table:
 *  - `/access-denied`: public static page (the OIDC group gate's refusal);
 *  - everything else sits behind `SessionGate` inside `AppShell`; every feature's routes are wrapped
 *    in an access check built from its `requires`; unknown addresses get a "not found" page.
 */
export function buildRoutes(features: readonly FeatureDefinition[]): RouteObject[] {
  return [
    { path: ACCESS_DENIED_PATH, element: <AccessDeniedPage />, HydrateFallback },
    {
      HydrateFallback,
      element: (
        <SessionGate>
          <AppShell features={features} />
        </SessionGate>
      ),
      children: [
        {
          // Errors inside a screen render here, inside the shell, so the navigation survives.
          errorElement: <RouteErrorPage />,
          children: [
            { index: true, element: <HomeRedirect features={features} /> },
            ...features.map((feature): RouteObject => ({
              element: <RequireAccess requires={feature.requires} />,
              children: feature.routes,
            })),
            { path: "*", element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}

export function createAppRouter(features: readonly FeatureDefinition[]) {
  return createBrowserRouter(buildRoutes(features));
}
