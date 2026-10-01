import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.js";

describe("@ytw/tokens", () => {
  it("is wired into the workspace", () => {
    expect(packageName).toBe("@ytw/tokens");
  });
});
