import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EnvError, baseEnvShape, describeEnv, loadEnv, renderEnvTable } from "../src/index.js";

const mcpSchema = z.object({
  ...baseEnvShape({ port: 3001 }),
  DATABASE_URL: z.url().describe("Connection string of the `ytw_mcp` role."),
  SESSION_SECRET: z.string().min(32).describe("Secret, at least 32 random characters."),
});

/** The message of the error `fn` throws; fails the test if it does not throw. */
function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the function to throw");
}

describe("loadEnv", () => {
  const valid = {
    DATABASE_URL: "postgres://ytw_mcp:pw@localhost:5432/ytw",
    SESSION_SECRET: "s".repeat(32),
  };

  it("applies the shared defaults", () => {
    const env = loadEnv(mcpSchema, valid);
    expect(env).toMatchObject({
      HOST: "0.0.0.0",
      PORT: 3001,
      LOG_LEVEL: "info",
      APP_VERSION: "0.0.0-dev",
      GIT_SHA: "unknown",
    });
    expect(env.METRICS_TOKEN).toBeUndefined();
  });

  it("takes the port default from the caller", () => {
    expect(loadEnv(z.object(baseEnvShape({ port: 3000 })), {}).PORT).toBe(3000);
  });

  it("parses and coerces provided values", () => {
    const env = loadEnv(mcpSchema, {
      ...valid,
      PORT: "8080",
      LOG_LEVEL: "debug",
      METRICS_TOKEN: "m".repeat(16),
    });
    expect(env).toMatchObject({ PORT: 8080, LOG_LEVEL: "debug", METRICS_TOKEN: "m".repeat(16) });
  });

  it("treats an empty value as unset", () => {
    const env = loadEnv(mcpSchema, { ...valid, PORT: "", LOG_LEVEL: "", METRICS_TOKEN: "" });
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.METRICS_TOKEN).toBeUndefined();
  });

  it("reports every bad variable at once, with the service name", () => {
    const bad = {
      PORT: "not-a-port",
      LOG_LEVEL: "verbose",
      SESSION_SECRET: "short",
      METRICS_TOKEN: "tiny",
    };
    expect(() => loadEnv(mcpSchema, bad, { service: "mcp" })).toThrow(EnvError);
    const message = errorMessage(() => loadEnv(mcpSchema, bad, { service: "mcp" }));
    expect(message.startsWith("Invalid environment for mcp:")).toBe(true);
    for (const name of ["PORT", "LOG_LEVEL", "SESSION_SECRET", "METRICS_TOKEN", "DATABASE_URL"]) {
      expect(message).toContain(`  - ${name}: `);
    }
  });

  it("never echoes a value, because several variables are secrets", () => {
    const secretish = "super-secret-but-too-short";
    const message = errorMessage(() =>
      loadEnv(mcpSchema, { ...valid, SESSION_SECRET: secretish, DATABASE_URL: secretish }),
    );
    expect(message).toContain("SESSION_SECRET");
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain(secretish);
  });

  it("names root-level problems from refinements", () => {
    const schema = z
      .object({ A: z.string().optional(), B: z.string().optional() })
      .refine((env) => !env.A || env.B, { message: "B is required when A is set" });
    expect(() => loadEnv(schema, { A: "x" })).toThrow(
      /\(environment\): B is required when A is set/,
    );
  });

  it("reads process.env by default", () => {
    process.env["YTW_TEST_ENV_VALUE"] = "from-process";
    try {
      expect(loadEnv(z.object({ YTW_TEST_ENV_VALUE: z.string() })).YTW_TEST_ENV_VALUE).toBe(
        "from-process",
      );
    } finally {
      delete process.env["YTW_TEST_ENV_VALUE"];
    }
  });
});

describe("describeEnv and renderEnvTable", () => {
  it("describes defaults, requirements, constraints and descriptions", () => {
    const docs = describeEnv(mcpSchema);
    const byName = Object.fromEntries(docs.map((doc) => [doc.name, doc]));
    expect(docs.map((doc) => doc.name)).toEqual([
      "HOST",
      "PORT",
      "LOG_LEVEL",
      "APP_VERSION",
      "GIT_SHA",
      "METRICS_TOKEN",
      "DATABASE_URL",
      "SESSION_SECRET",
    ]);
    expect(byName["PORT"]).toEqual({
      name: "PORT",
      required: false,
      default: "3001",
      type: "integer 1 to 65535",
      description: "Port to listen on.",
    });
    expect(byName["LOG_LEVEL"]?.type).toBe("one of fatal, error, warn, info, debug, trace, silent");
    expect(byName["DATABASE_URL"]).toMatchObject({ required: true, type: "URL" });
    expect(byName["SESSION_SECRET"]).toMatchObject({
      required: true,
      type: "string, at least 32 characters",
    });
    expect(byName["METRICS_TOKEN"]).toMatchObject({ required: false });
    expect(byName["METRICS_TOKEN"]).not.toHaveProperty("default");
  });

  it("copes with refinements and transforms", () => {
    const schema = z
      .object({
        FLAG: z
          .enum(["true", "false"])
          .default("false")
          .transform((value) => value === "true")
          .describe("A switch."),
        LIST: z.string().transform((value) => value.split(",")),
      })
      .refine(() => true);
    expect(describeEnv(schema)).toEqual([
      {
        name: "FLAG",
        required: false,
        default: "false",
        type: "one of true, false",
        description: "A switch.",
      },
      { name: "LIST", required: true, type: "string", description: "" },
    ]);
  });

  it("renders a markdown table and escapes cell separators", () => {
    const schema = z.object({
      MODE: z.enum(["a", "b"]).default("a").describe("Pick one | or the other.\nSecond line."),
      COUNT: z.coerce.number().int().min(1).describe("How many."),
    });
    expect(renderEnvTable(schema)).toBe(
      [
        "| Variable | Required | Default | Values | Description |",
        "| --- | --- | --- | --- | --- |",
        "| `MODE` | no | `a` | one of a, b | Pick one \\| or the other. Second line. |",
        "| `COUNT` | yes |  | integer >= 1 | How many. |",
      ].join("\n"),
    );
  });

  it("accepts already described rows", () => {
    expect(
      renderEnvTable([{ name: "X", required: true, type: "string", description: "An x." }]),
    ).toContain("| `X` | yes |  | string | An x. |");
  });

  it("is what docs/observability.md shows for the shared variables", () => {
    const doc = readFileSync(
      fileURLToPath(new URL("../../../docs/observability.md", import.meta.url)),
      "utf8",
    );
    expect(doc).toContain(renderEnvTable(z.object(baseEnvShape({ port: 3000 }))));
  });
});
