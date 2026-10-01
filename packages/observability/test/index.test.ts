import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.js";

describe("@ytw/observability", () => {
  it("is wired into the workspace", () => {
    expect(packageName).toBe("@ytw/observability");
  });
});
