import { FlaskConical } from "lucide-react";
import { defineFeature } from "@/app/features.ts";

export default defineFeature({
  id: "experiments",
  requires: { resource: "experiments", level: "read" },
  nav: { label: "Experiments", icon: FlaskConical, order: 40 },
  routes: [
    { path: "experiments", lazy: () => import("./ExperimentsPage.tsx") },
    { path: "experiments/:experimentId", lazy: () => import("./ExperimentDetailPage.tsx") },
  ],
});
