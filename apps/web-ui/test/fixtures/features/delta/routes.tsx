import { Settings } from "lucide-react";
import { defineFeature } from "../../../../src/app/features.ts";

export default defineFeature({
  id: "delta",
  requires: "any",
  nav: { label: "Delta", icon: Settings, order: 90 },
  routes: [{ path: "delta", element: <h1>Delta page</h1> }],
});
