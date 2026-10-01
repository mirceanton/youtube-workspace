import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.js";

describe("@ytw/e2e", () => {
  it("is wired into the workspace", () => {
    expect(packageName).toBe("@ytw/e2e");
  });
});
