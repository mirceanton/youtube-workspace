import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "../src/api/health.js";
import {
  ACTOR_TYPES,
  EXPERIMENT_STATUSES,
  EXPERIMENT_TYPES,
  NOTE_ENTITY_TYPES,
  SCRIPT_BODY_MAX_BYTES,
  SCRIPT_KINDS,
  SCRIPT_STATUSES,
  experimentStatusSchema,
  scriptKindSchema,
} from "../src/index.js";

describe("status and type enums", () => {
  it("match PRD 4", () => {
    expect(SCRIPT_KINDS).toEqual(["script", "packaging"]);
    expect(SCRIPT_STATUSES).toEqual(["draft", "review", "approved"]);
    expect(EXPERIMENT_TYPES).toEqual(["title", "thumbnail", "description"]);
    expect(EXPERIMENT_STATUSES).toEqual(["planned", "running", "concluded", "cancelled"]);
    expect(ACTOR_TYPES).toEqual(["human", "agent"]);
    expect(NOTE_ENTITY_TYPES).toEqual(["idea", "script", "video", "experiment"]);
  });

  it("reject values outside the enum", () => {
    expect(scriptKindSchema.safeParse("thumbnail").success).toBe(false);
    expect(experimentStatusSchema.safeParse("done").success).toBe(false);
  });

  it("fix the script body limit at 1 MiB", () => {
    expect(SCRIPT_BODY_MAX_BYTES).toBe(1024 * 1024);
  });
});

describe("health response schema", () => {
  it("accepts what both services return and rejects unknown services", () => {
    const body = { status: "ok", service: "mcp", version: "0.0.0-dev", commit: "unknown" };
    expect(healthResponseSchema.parse(body)).toEqual(body);
    expect(healthResponseSchema.safeParse({ ...body, service: "worker" }).success).toBe(false);
  });
});
