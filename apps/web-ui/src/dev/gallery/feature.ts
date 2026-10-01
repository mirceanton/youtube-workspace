import { Shapes } from "lucide-react";
import { defineFeature } from "@/app/features.ts";

/** The kit gallery as a feature declaration; registered by main.tsx in development only. */
export const galleryFeature = defineFeature({
  id: "kit",
  requires: "authenticated",
  nav: { label: "UI kit", icon: Shapes, order: 99 },
  routes: [{ path: "kit", lazy: () => import("./Gallery.tsx") }],
});
