import { LayoutDashboard } from "lucide-react";
import { defineFeature } from "@/app/features.ts";

export default defineFeature({
  id: "dashboard",
  requires: [
    { resource: "ideas", level: "read" },
    { resource: "experiments", level: "read" },
    { resource: "videos", level: "read" },
    { resource: "activity", level: "read" },
  ],
  nav: { label: "Dashboard", icon: LayoutDashboard, order: 10 },
  routes: [{ path: "dashboard", lazy: () => import("./DashboardPage.tsx") }],
});
