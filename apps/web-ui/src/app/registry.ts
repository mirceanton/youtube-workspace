import { discoverFeatures } from "./features.ts";

// Every `src/features/<feature>/routes.tsx` is picked up here. The glob is eager because a
// `routes.tsx` only declares metadata and lazy route loaders (the pages are code-split by their
// `lazy: () => import(...)`), so the shell needs no further work when a feature is added.
const modules = import.meta.glob("../features/*/routes.tsx", { eager: true });

export const features = discoverFeatures(modules);
