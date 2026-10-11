import { createTestDb, type TestDb } from "@ytw/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FailureLimiter, generateToken } from "../src/tokens/index.js";
import { callTool, envFor, toolNames } from "./helpers.js";

let db: TestDb;
let app: FastifyInstance;
const agent = generateToken();

beforeAll(async () => {
  db = await createTestDb({ migrate: false });
  app = await buildApp(
    envFor(db, {
      MCP_BOOTSTRAP_TOKEN: agent.secret,
      MCP_BOOTSTRAP_TOKEN_NAME: "agent",
      MCP_BOOTSTRAP_TOKEN_PERMISSIONS: "videos=write,experiments=write",
    }),
    { pool: db.pool, limiter: new FailureLimiter({ maxFailures: 100 }) },
  );
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe("experiment tools", () => {
  it("lets an agent take an experiment from planned to running to concluded", async () => {
    expect(await toolNames(app, agent.secret)).toContain("update_experiment_status");

    const video = await callTool(app, agent.secret, "register_video", {
      youtube_id: "dQw4w9WgXcQ",
      title: "Packaging test",
    });
    const created = await callTool(app, agent.secret, "create_experiment", {
      video_id: video.json["id"],
      type: "title",
      variants: [
        { label: "Current", content: "Packaging test", is_control: true },
        { label: "Question", content: "Does packaging matter?" },
      ],
    });
    expect(created.isError).toBe(false);
    expect(created.json).toMatchObject({ status: "planned", startsAt: null });

    const started = await callTool(app, agent.secret, "update_experiment_status", {
      id: created.json["id"],
      new_status: "running",
    });
    expect(started.isError).toBe(false);
    expect(started.json).toMatchObject({ status: "running" });
    expect(started.json["startsAt"]).not.toBeNull();

    const concluded = await callTool(app, agent.secret, "conclude_experiment", {
      id: created.json["id"],
      conclusion: "No difference.",
    });
    expect(concluded.isError).toBe(false);
    expect(concluded.json).toMatchObject({ status: "concluded" });
  });

  it("refuses a move the status machine forbids, saying which statuses are valid", async () => {
    const video = await callTool(app, agent.secret, "register_video", {
      youtube_id: "9bZkp7q19f0",
      title: "Cancelled test",
    });
    const created = await callTool(app, agent.secret, "create_experiment", {
      video_id: video.json["id"],
      type: "thumbnail",
      variants: [
        { label: "Current", content: "thumb-a.png", is_control: true },
        { label: "Bold", content: "thumb-b.png" },
      ],
    });
    const cancelled = await callTool(app, agent.secret, "update_experiment_status", {
      id: created.json["id"],
      new_status: "cancelled",
    });
    expect(cancelled.json).toMatchObject({ status: "cancelled" });

    const restarted = await callTool(app, agent.secret, "update_experiment_status", {
      id: created.json["id"],
      new_status: "running",
    });
    expect(restarted.isError).toBe(true);
    expect(restarted.text).toMatch(/final/);
  });
});
