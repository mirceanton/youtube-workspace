import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.js";

describe("@ytw/db", () => {
  it("is wired into the workspace", () => {
    expect(packageName).toBe("@ytw/db");
  });
});
