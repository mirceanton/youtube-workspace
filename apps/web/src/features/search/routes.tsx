import { Search } from "lucide-react";
import { defineFeature } from "@/app/features.ts";

export default defineFeature({
  id: "search",
  requires: [
    { resource: "ideas", level: "read" },
    { resource: "scripts", level: "read" },
  ],
  nav: { label: "Search", icon: Search, order: 70 },
  routes: [{ path: "search", lazy: () => import("./SearchPage.tsx") }],
});
