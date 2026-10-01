import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/App.tsx";
import { discoverFeatures } from "../../src/app/features.ts";
import { createAppRouter } from "../../src/app/router.tsx";
import { createQueryClient } from "../../src/lib/query-client.ts";
import "../../src/index.css";

// A stand-in for src/main.tsx used by test/node/bundle.test.ts: the same shell, plus one feature
// that uses every heavy part of the UI kit. The test builds this entry and checks that the heavy
// parts (zod, uPlot, the markdown renderer) end up in lazy chunks, not in the initial download.
const features = discoverFeatures(import.meta.glob("./features/*/routes.tsx", { eager: true }));

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App router={createAppRouter(features)} queryClient={createQueryClient()} />
    </StrictMode>,
  );
}
