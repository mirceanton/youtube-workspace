import { RESOURCES, type Level, type Resource } from "@ytw/shared";
import { describe, expect, it } from "vitest";
import {
  FULL_ACCESS,
  NO_ACCESS,
  canGrant,
  grantCeiling,
  grantOptions,
  grantViolations,
} from "../src/index.js";
import { raw } from "./fixtures.js";

type Requested = Partial<Record<Resource, Level>>;

describe("grantOptions", () => {
  it.each([
    ["none", ["none"]],
    ["read", ["none", "read"]],
    ["write", ["none", "read", "write"]],
  ] as const)("an owner with %s offers %j", (owner, options) => {
    expect(grantOptions({ ...NO_ACCESS, ideas: owner }).ideas).toEqual(options);
  });

  it("never offers write on the activity log", () => {
    expect(grantOptions(raw("write")).activity).toEqual(["none", "read"]);
  });

  it("gives an admin's user record the maximum everywhere, whatever rows are stored", () => {
    const admin = { isAdmin: true, levels: NO_ACCESS };
    expect(grantCeiling(admin)).toEqual(FULL_ACCESS);
    expect(canGrant(admin, { ...FULL_ACCESS })).toBe(true);
    // A bare map is taken as already-effective levels: an admin's stored map alone is not enough.
    expect(canGrant(NO_ACCESS, { ideas: "write" })).toBe(false);
  });
});

describe("grantViolations", () => {
  it("never lets a token exceed its owner, and reports every violation", () => {
    const owner = { ...NO_ACCESS, ideas: "write", scripts: "read", activity: "read" } as const;
    const violations = grantViolations(owner, raw("write"));
    expect(violations.map((v) => [v.resource, v.reason])).toEqual(
      RESOURCES.filter((r) => r !== "ideas").map((r) => [
        r,
        r === "activity" ? "not_grantable" : "exceeds_owner",
      ]),
    );
  });

  it("explains what failed and which values are valid", () => {
    const owner = { ...NO_ACCESS, scripts: "read" } as const;
    const requested = { scripts: "write", notes: "admin", typo: "read" } as unknown as Requested;
    const violations = grantViolations(owner, requested);
    expect(violations.map((v) => [v.resource, v.reason, v.allowed])).toEqual([
      ["scripts", "exceeds_owner", ["none", "read"]],
      ["notes", "invalid_level", ["none"]],
      ["typo", "unknown_resource", []],
    ]);
    expect(violations[0]?.message).toBe(
      "write on scripts is above the owner's own level (read); a token never exceeds its owner; choose one of: none, read",
    );
    expect(canGrant(owner, requested)).toBe(false);
  });
});
