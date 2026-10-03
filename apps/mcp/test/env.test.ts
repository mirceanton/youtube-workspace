import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "../src/env.js";

describe("mcp env", () => {
  it("applies defaults when nothing is set", () => {
    expect(loadEnv({})).toEqual({
      HOST: "0.0.0.0",
      PORT: 3001,
      LOG_LEVEL: "info",
      APP_VERSION: "0.0.0-dev",
      GIT_SHA: "unknown",
      DATABASE_URL: "postgres://ytw_mcp:ytw_mcp@localhost:5432/youtube_workspace",
    });
  });

  it("treats empty values as unset", () => {
    expect(loadEnv({ PORT: "", LOG_LEVEL: "" })).toMatchObject({ PORT: 3001, LOG_LEVEL: "info" });
  });

  it("coerces PORT and keeps explicit values", () => {
    expect(loadEnv({ PORT: "8081", LOG_LEVEL: "debug" })).toMatchObject({
      PORT: 8081,
      LOG_LEVEL: "debug",
    });
  });

  it("fails fast with a message naming every bad variable", () => {
    let error: unknown;
    try {
      loadEnv({ PORT: "eighty", LOG_LEVEL: "loud" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EnvError);
    const message = (error as EnvError).message;
    expect(message).toContain("Invalid environment for mcp");
    expect(message).toContain("PORT");
    expect(message).toContain("LOG_LEVEL");
  });

  it("rejects out-of-range ports", () => {
    expect(() => loadEnv({ PORT: "70000" })).toThrow(EnvError);
  });
});
