import { describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  FULL_ACCESS,
  NO_ACCESS,
  PolicyError,
  assertAccess,
  authorize,
  can,
  canCreateTokens,
  hasReadOnEverything,
  type AccessRule,
  type Principal,
  type Requirement,
} from "../src/index.js";
import { raw, token, user } from "./fixtures.js";

const scriptsWrite: Requirement = { resource: "scripts", level: "write" };

const scriptsAt = (scripts: "read" | "write") => ({ ...NO_ACCESS, scripts });

function denialFor(own: "read" | "write", owner: "read" | "write"): string {
  const decision = authorize(token(scriptsAt(own), scriptsAt(owner)), scriptsWrite);
  return decision.allowed ? "" : decision.message;
}

describe("resource helpers", () => {
  it("answers false, not an error, for write on the read-only activity log", () => {
    const admin = user(raw("write"), { isAdmin: true });
    expect(can(admin, "activity", "write")).toBe(false);
    expect(can(admin, "activity", "read")).toBe(true);
    expect(() => can(admin, "ideas", "none" as "read")).toThrow(PolicyError);
  });

  it("reports read on every object only when both a token and its owner have it", () => {
    const missingNotes = { ...raw("read"), notes: "none" } as const;
    expect(hasReadOnEverything(user(raw("read")))).toBe(true);
    expect(hasReadOnEverything(token(raw("read"), FULL_ACCESS))).toBe(true);
    expect(hasReadOnEverything(user(missingNotes))).toBe(false);
    expect(hasReadOnEverything(token(raw("read"), missingNotes))).toBe(false);
    expect(hasReadOnEverything(token(missingNotes, raw("read")))).toBe(false);
  });

  it("lets users with some access create tokens, never tokens", () => {
    expect(canCreateTokens(user({ ...NO_ACCESS, videos: "read" }))).toBe(true);
    expect(canCreateTokens(user(NO_ACCESS))).toBe(false);
    expect(canCreateTokens(token(FULL_ACCESS, FULL_ACCESS))).toBe(false);
  });
});

describe("authorize", () => {
  it("allows public rules without a principal and demands one for everything else", () => {
    expect(authorize(undefined, "public")).toEqual({ allowed: true });
    for (const rule of ["authenticated", "admin", scriptsWrite] as AccessRule[]) {
      expect(authorize(undefined, rule)).toMatchObject({
        allowed: false,
        reason: "unauthenticated",
      });
    }
    expect(authorize(user(NO_ACCESS), "authenticated").allowed).toBe(true);
  });

  it("throws for a bad declaration or principal: that is a bug, not a denial", () => {
    const bad = { resource: "activity", level: "write" } as const;
    expect(() => authorize(undefined, bad)).toThrow(
      "write can never be held on activity (its maximum is read)",
    );
    expect(() => authorize(user(FULL_ACCESS), "everyone" as AccessRule)).toThrow(PolicyError);
    expect(() => authorize({ kind: "ghost" } as unknown as Principal, "authenticated")).toThrow(
      PolicyError,
    );
  });

  it("allows admin rules only for admin users, never for their tokens", () => {
    expect(authorize(user(NO_ACCESS, { isAdmin: true }), "admin")).toEqual({ allowed: true });
    expect(authorize(user(FULL_ACCESS), "admin")).toMatchObject({ allowed: false });
    const adminsToken = token(FULL_ACCESS, FULL_ACCESS, { ownerIsAdmin: true });
    expect(authorize(adminsToken, "admin")).toMatchObject({ allowed: false, reason: "forbidden" });
  });

  it("tells a token whether its own level or its owner's is the limit", () => {
    expect(denialFor("read", "write")).toContain("The owner can raise this token's level");
    expect(denialFor("write", "read")).toContain("An admin must raise the owner's level in");
    expect(denialFor("read", "read")).toContain("then the owner can raise the token's level");
  });
});

describe("assertAccess", () => {
  it("returns quietly when allowed and throws an AccessDeniedError otherwise", () => {
    expect(() => assertAccess(user(FULL_ACCESS), scriptsWrite)).not.toThrow();
    expect(() => assertAccess(undefined, scriptsWrite)).toThrow(
      expect.objectContaining({ name: "AccessDeniedError", reason: "unauthenticated" }),
    );
    expect(() => assertAccess(user(NO_ACCESS), scriptsWrite)).toThrow(AccessDeniedError);
  });
});
