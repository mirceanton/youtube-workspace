// Entry point "@ytw/shared/constants": the domain values, types and helpers without zod. The web UI
// shell imports from here to keep zod out of its initial bundle; everything else may use the
// "@ytw/shared" barrel, which adds the zod schemas.
export * from "./enums.js";
export * from "./idea-stages.js";
export * from "./limits.js";
export * from "./resources.js";
