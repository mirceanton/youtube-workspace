import { FileText } from "lucide-react";
import { defineFeature } from "@/app/features.ts";

export default defineFeature({
  id: "scripts",
  requires: { resource: "scripts", level: "read" },
  nav: { label: "Scripts", icon: FileText, order: 30 },
  routes: [
    { path: "scripts", lazy: () => import("./ScriptsIndexPage.tsx") },
    { path: "scripts/:ideaId/:kind", lazy: () => import("./ScriptPage.tsx") },
  ],
});
