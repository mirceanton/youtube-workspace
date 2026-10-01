import { FileText } from "lucide-react";
import { defineFeature } from "../../../../src/app/features.ts";

export default defineFeature({
  id: "beta",
  requires: { resource: "scripts", level: "write" },
  nav: { label: "Beta", icon: FileText, order: 10 },
  routes: [{ path: "beta", element: <h1>Beta page</h1> }],
});
