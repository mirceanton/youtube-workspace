import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { features } from "./app/registry.ts";
import { createAppRouter } from "./app/router.tsx";
import type { FeatureDefinition } from "./app/features.ts";
import { createQueryClient } from "./lib/query-client.ts";
import { fetchMe, ME_QUERY_KEY } from "./lib/session.ts";
import "./index.css";

async function bootstrap() {
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("index.html is missing the #root element");
  }

  let all: readonly FeatureDefinition[] = features;
  if (import.meta.env.DEV) {
    // Development only: mock API (when no web server answers) and the UI kit gallery. Production
    // builds replace `import.meta.env.DEV` with `false`, so this whole branch and its module
    // graph are removed.
    const dev = await import("./dev/install.ts");
    await dev.installDevMocks();
    all = [...features, dev.galleryFeature];
  }

  const queryClient = createQueryClient();
  // Ask who is signed in while the first page's code downloads, instead of after it.
  void queryClient.prefetchQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => fetchMe(signal),
  });

  createRoot(container).render(
    <StrictMode>
      <App router={createAppRouter(all)} queryClient={queryClient} />
    </StrictMode>,
  );
}

void bootstrap();
