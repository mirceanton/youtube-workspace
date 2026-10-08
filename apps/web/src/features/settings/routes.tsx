import { Settings } from "lucide-react";
import { defineFeature } from "@/app/features.ts";

export default defineFeature({
  id: "settings",
  requires: "authenticated",
  nav: { label: "Settings", icon: Settings, order: 90 },
  routes: [
    { path: "settings", lazy: () => import("./SettingsPage.tsx") },
    { path: "settings/tokens/:tokenId", lazy: () => import("./TokenDetailPage.tsx") },
    { path: "settings/users/:userId", lazy: () => import("./UserAccessPage.tsx") },
  ],
});
