import { Lightbulb } from "lucide-react";
import { defineFeature } from "@/app/features.ts";

export default defineFeature({
  id: "ideas",
  requires: { resource: "ideas", level: "read" },
  nav: { label: "Ideas", icon: Lightbulb, order: 20 },
  routes: [
    { path: "ideas", lazy: () => import("./IdeasPage.tsx") },
    { path: "ideas/:ideaId", lazy: () => import("./IdeaDetailPage.tsx") },
  ],
});
