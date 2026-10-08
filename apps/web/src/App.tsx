import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { RouterProvider } from "react-router";
import { RootErrorBoundary } from "./app/RootErrorBoundary.tsx";

/** Providers around the router: error boundary, TanStack Query. The router is built in main.tsx (or in tests). */
export function App({
  router,
  queryClient,
}: {
  router: ComponentProps<typeof RouterProvider>["router"];
  queryClient: QueryClient;
}) {
  return (
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </RootErrorBoundary>
  );
}
