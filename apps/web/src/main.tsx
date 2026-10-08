import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { features } from "./app/registry.ts";
import { createAppRouter } from "./app/router.tsx";
import { createQueryClient } from "./lib/query-client.ts";
import { fetchMe, ME_QUERY_KEY } from "./lib/session.ts";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html is missing the #root element");
}

const queryClient = createQueryClient();
// Ask who is signed in while the first page's code downloads, instead of after it.
void queryClient.prefetchQuery({
  queryKey: ME_QUERY_KEY,
  queryFn: ({ signal }) => fetchMe(signal),
});

createRoot(container).render(
  <StrictMode>
    <App router={createAppRouter(features)} queryClient={queryClient} />
  </StrictMode>,
);
