import { Lightbulb } from "lucide-react";
import { defineFeature } from "../../../../src/app/features.ts";

export default defineFeature({
  id: "alpha",
  requires: { resource: "ideas", level: "read" },
  nav: { label: "Alpha", icon: Lightbulb, order: 20 },
  routes: [
    { path: "alpha", lazy: () => import("./AlphaPage.tsx") },
    { path: "alpha/:itemId", lazy: () => import("./AlphaDetailPage.tsx") },
  ],
});
