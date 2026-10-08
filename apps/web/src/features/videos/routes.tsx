import { Video } from "lucide-react";
import { defineFeature } from "@/app/features.ts";

export default defineFeature({
  id: "videos",
  requires: { resource: "videos", level: "read" },
  nav: { label: "Videos", icon: Video, order: 60 },
  routes: [
    { path: "videos", lazy: () => import("./VideosPage.tsx") },
    { path: "videos/:videoId", lazy: () => import("./VideoDetailPage.tsx") },
  ],
});
