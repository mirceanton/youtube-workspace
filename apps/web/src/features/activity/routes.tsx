import { ListTodo } from "lucide-react";
import { defineFeature } from "@/app/features.ts";

export default defineFeature({
  id: "activity",
  requires: { resource: "activity", level: "read" },
  nav: { label: "Activity", icon: ListTodo, order: 60, footer: true },
  routes: [{ path: "activity", lazy: () => import("./ActivityPage.tsx") }],
});
