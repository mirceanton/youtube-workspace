import { Activity } from "lucide-react";
import { defineFeature } from "../../../../src/app/features.ts";

export default defineFeature({
  id: "gamma",
  requires: [
    { resource: "activity", level: "read" },
    { resource: "experiments", level: "write" },
  ],
  nav: { label: "Gamma", icon: Activity, order: 60 },
  routes: [{ path: "gamma", element: <h1>Gamma page</h1> }],
});
