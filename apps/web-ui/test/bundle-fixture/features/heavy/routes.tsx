import { Gauge } from "lucide-react";
import { defineFeature } from "../../../../src/app/features.ts";

export default defineFeature({
  id: "heavy",
  requires: "any",
  nav: { label: "Heavy", icon: Gauge, order: 10 },
  routes: [{ path: "heavy", lazy: () => import("./HeavyPage.tsx") }],
});
