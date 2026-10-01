import { defineFeature } from "../../../../src/app/features.ts";

// No nav item: reachable only by link.
export default defineFeature({
  id: "hidden",
  requires: { resource: "ideas", level: "read" },
  routes: [{ path: "hidden", element: <h1>Hidden page</h1> }],
});
