// parseResourceLevels: how the wrappers read the `jsonb` level maps the identity functions return.
// It follows @ytw/policy levelsFromRecord, so a migration that adds an object type can run before
// the services that know it are deployed (docs/policy.md, "Verify and ship").
// toTokenPrincipal: only an active token has a principal.
import { RESOURCES } from "@ytw/shared/constants";
import { levelsFromRecord, principalLevels } from "@ytw/policy";
import { describe, expect, it } from "vitest";
import { parseResourceLevels } from "../src/permissions.js";
import { toTokenPrincipal, type ApiTokenStatus, type FoundToken } from "../src/tokens.js";

const FULL = {
  ideas: "write",
  scripts: "read",
  experiments: "none",
  videos: "read",
  notes: "write",
  activity: "read",
};

describe("parseResourceLevels", () => {
  it("returns a complete map unchanged", () => {
    expect(parseResourceLevels(FULL)).toEqual(FULL);
  });

  it("ignores objects this build does not know (a migration may run before the services)", () => {
    expect(parseResourceLevels({ ...FULL, sponsors: "write", reports: "read" })).toEqual(FULL);
  });

  it("reads an object the database does not list yet as none (fail closed)", () => {
    const { notes: _notes, activity: _activity, ...partial } = FULL;
    expect(parseResourceLevels(partial)).toEqual({ ...FULL, notes: "none", activity: "none" });
    expect(parseResourceLevels({})).toEqual(
      Object.fromEntries(RESOURCES.map((resource) => [resource, "none"])),
    );
  });

  it.each([["admin"], [5], [null], [true], [["read"]], [{ level: "read" }]])(
    "refuses a value that is not a level (%j) rather than guessing",
    (bad) => {
      expect(() => parseResourceLevels({ ...FULL, scripts: bad }, "the levels of token x")).toThrow(
        "the database returned the levels of token x with an invalid level for scripts",
      );
    },
  );

  it.each([[null], [undefined], ["ideas"], [5], [[]], [["ideas", "read"]]])(
    "refuses something that is not an object (%j)",
    (bad) => {
      expect(() => parseResourceLevels(bad)).toThrow(/that are not an object$/);
    },
  );

  it("agrees with @ytw/policy levelsFromRecord on everything the policy accepts", () => {
    const records: Record<string, unknown>[] = [
      FULL,
      { ...FULL, sponsors: "write" },
      { ideas: "read" },
      {},
      { notes: "write", unknown: "read" },
    ];
    for (const record of records) {
      expect(parseResourceLevels(record)).toEqual(levelsFromRecord(record));
    }
  });
});

const NONE = parseResourceLevels({});
const READ_IDEAS = parseResourceLevels({ ideas: "read" });

function found(status: ApiTokenStatus): FoundToken {
  return {
    status,
    id: "00000000-0000-4000-8000-000000000001",
    name: "bot",
    prefix: "ytw_abcdefgh",
    createdAt: new Date(0),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    owner: {
      id: "00000000-0000-4000-8000-000000000002",
      username: "owner",
      isAdmin: false,
      levels: READ_IDEAS,
    },
    levels: READ_IDEAS,
    effectiveLevels: status === "active" ? READ_IDEAS : NONE,
  };
}

describe("toTokenPrincipal", () => {
  it("builds the principal of an active token: its levels are the effective levels", () => {
    const active = found("active");
    const principal = toTokenPrincipal(active);
    expect(principal).toMatchObject({ kind: "token", tokenId: active.id, tokenName: "bot" });
    expect(principalLevels({ ...principal })).toEqual(active.effectiveLevels);
  });

  it.each(["revoked", "expired", "owner_revoked"] as const)(
    "throws for a %s token instead of granting its own levels",
    (status) => {
      expect(() => toTokenPrincipal(found(status))).toThrow(
        new RegExp(`is ${status}, and only an active token has a principal`),
      );
    },
  );

  it("never puts the secret-derived values of the token into the message", () => {
    const token = { ...found("revoked"), prefix: "ytw_SECRETABC" };
    expect(() => toTokenPrincipal(token)).toThrow(/^(?!.*SECRETABC)/);
  });
});
