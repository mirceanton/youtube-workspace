import { RESOURCES, type Level, type Resource } from "@ytw/shared";
import { describe, expect, it } from "vitest";
import {
  FULL_ACCESS,
  NO_ACCESS,
  canGrant,
  grantCeiling,
  grantOptions,
  grantViolations,
  userLevels,
} from "../src/index.js";
import { VALID_OBJECTS, oracleMax, raw } from "./fixtures.js";

type Requested = Partial<Record<Resource, Level>>;

/** PRD 7: owner Write -> None/Read/Write; owner Read -> None/Read; activity never Write. */
function expectedOptions(resource: Resource, owner: Level): Level[] {
  const byOwner: Record<Level, Level[]> = {
    none: ["none"],
    read: ["none", "read"],
    write: ["none", "read", "write"],
  };
  return oracleMax(resource) === "read"
    ? byOwner[owner].filter((l) => l !== "write")
    : byOwner[owner];
}

const grantCases = RESOURCES.flatMap((resource) =>
  (["none", "read", "write"] as const).flatMap((owner) =>
    (["none", "read", "write"] as const).map((requested) => ({ resource, owner, requested })),
  ),
);

describe("grant ceiling x resource x owner level x requested level", () => {
  it.each(grantCases)(
    "$resource: owner $owner, requested $requested",
    ({ resource, owner, requested }) => {
      const ownerLevels = { ...NO_ACCESS, [resource]: owner };
      const allowed = expectedOptions(resource, owner);
      expect(grantOptions(ownerLevels)[resource]).toEqual(allowed);

      const ok = allowed.includes(requested);
      expect(canGrant(ownerLevels, { [resource]: requested })).toBe(ok);
      const reason =
        oracleMax(resource) === "read" && requested === "write" ? "not_grantable" : "exceeds_owner";
      const expected = ok ? [] : [{ resource, requested, allowed, reason }];
      const violations = grantViolations(ownerLevels, { [resource]: requested });
      expect(violations.map(({ message: _message, ...rest }) => rest)).toEqual(expected);
    },
  );
});

describe("grantCeiling and grantOptions", () => {
  it("is the owner's level capped per object", () => {
    expect(grantCeiling(raw("write"))).toEqual(FULL_ACCESS);
    expect(grantCeiling({ ...NO_ACCESS, scripts: "read" })).toEqual({
      ...NO_ACCESS,
      scripts: "read",
    });
  });

  it("lets an admin grant the maximum everywhere through userLevels", () => {
    const owner = userLevels({ isAdmin: true, levels: NO_ACCESS });
    expect(canGrant(owner, { ...FULL_ACCESS })).toBe(true);
    expect(grantOptions(owner)).toEqual(
      Object.fromEntries(RESOURCES.map((r) => [r, expectedOptions(r, "write")])),
    );
    expect(grantOptions(owner).activity).toEqual(["none", "read"]);
  });
});

describe("grantViolations", () => {
  it("accepts an empty or partial request, skipping objects left out", () => {
    expect(grantViolations(NO_ACCESS, {})).toEqual([]);
    expect(grantViolations({ ...NO_ACCESS, ideas: "read" }, { ideas: "read" })).toEqual([]);
    expect(grantViolations(NO_ACCESS, { ideas: undefined })).toEqual([]);
  });

  it("checks a full map and reports every violation, in request order", () => {
    const owner = { ...NO_ACCESS, ideas: "write", scripts: "read", activity: "read" } as const;
    const violations = grantViolations(owner, { ...raw("write") });
    expect(violations.map((v) => [v.resource, v.reason])).toEqual(
      RESOURCES.filter((r) => r !== "ideas").map((r) => [
        r,
        oracleMax(r) === "read" ? "not_grantable" : "exceeds_owner",
      ]),
    );
    expect(violations.find((v) => v.resource === "activity")?.reason).toBe("not_grantable");
  });

  it("writes messages that say what failed and which values are valid", () => {
    const owner = { ...NO_ACCESS, scripts: "read", activity: "read" } as const;
    const requested = {
      scripts: "write",
      activity: "write",
      notes: "admin",
      not_an_object: "read",
    } as unknown as Requested;
    expect(grantViolations(owner, requested)).toEqual([
      {
        resource: "scripts",
        requested: "write",
        reason: "exceeds_owner",
        allowed: ["none", "read"],
        message:
          "write on scripts is above the owner's own level (read); a token never exceeds its owner; choose one of: none, read",
      },
      {
        resource: "activity",
        requested: "write",
        reason: "not_grantable",
        allowed: ["none", "read"],
        message:
          "write is never allowed on activity (it allows none, read); choose one of: none, read",
      },
      {
        resource: "notes",
        requested: "admin",
        reason: "invalid_level",
        allowed: ["none"],
        message: '"admin" is not an access level for notes; choose one of: none',
      },
      {
        resource: "not_an_object",
        requested: "read",
        reason: "unknown_resource",
        allowed: [],
        message: `"not_an_object" is not an object with access levels; valid objects: ${VALID_OBJECTS}`,
      },
    ]);
    expect(canGrant(owner, requested)).toBe(false);
  });

  it("refuses an unknown object even at none, so typos never pass silently", () => {
    expect(canGrant(FULL_ACCESS, { idea: "none" } as unknown as Requested)).toBe(false);
  });
});
