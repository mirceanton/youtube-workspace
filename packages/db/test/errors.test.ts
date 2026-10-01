import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_ERROR_CATALOGUE,
  DbError,
  DuplicateError,
  ForbiddenError,
  ImmutableError,
  InvalidTransitionError,
  MissingActorError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  dbErrorKind,
  formatAllowed,
  formatDbError,
  isPgError,
  toDbError,
  type DbErrorKind,
} from "../src/errors.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { failure } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

async function raised(kind: string, message: string, detail: unknown, hint: string | null) {
  return failure(
    db.admin.query("SELECT ytw_raise($1, $2, $3::jsonb, $4)", [
      kind,
      message,
      JSON.stringify(detail),
      hint,
    ]),
  );
}

const CLASSES: Record<DbErrorKind, new (...args: never[]) => DbError> = {
  validation: ValidationError,
  not_found: NotFoundError,
  forbidden: ForbiddenError,
  version_conflict: VersionConflictError,
  invalid_transition: InvalidTransitionError,
  duplicate: DuplicateError,
  immutable: ImmutableError,
  missing_actor: MissingActorError,
};

describe("SQLSTATE catalogue", () => {
  it("is the same in TypeScript and in ytw_error_codes()", async () => {
    const { rows } = await db.admin.query<{ kind: string; sqlstate: string }>(
      "SELECT kind, sqlstate FROM ytw_error_codes() ORDER BY sqlstate",
    );
    expect(rows).toEqual(DB_ERROR_CATALOGUE.map(({ kind, sqlstate }) => ({ kind, sqlstate })));
    expect(new Set(DB_ERROR_CATALOGUE.map((entry) => entry.sqlstate)).size).toBe(rows.length);
  });

  it.each(DB_ERROR_CATALOGUE.map((entry) => [entry.kind, entry] as const))(
    "maps %s raised by ytw_raise to its typed error",
    async (kind, entry) => {
      const err = toDbError(
        await raised(kind, `the ${kind} message`, { field: "x", latest_version: 3 }, "try this"),
      );
      expect(err).toBeInstanceOf(CLASSES[kind]);
      expect(err).toBeInstanceOf(DbError);
      const typed = err as DbError;
      expect(typed).toMatchObject({
        kind,
        sqlstate: entry.sqlstate,
        status: entry.status,
        message: `the ${kind} message`,
        hint: "try this",
        details: { field: "x", latest_version: 3 },
      });
      expect(isPgError(typed.cause)).toBe(true);
    },
  );

  it("keeps 409 for version conflicts only (the web UI's reload-or-merge dialog)", () => {
    expect(DB_ERROR_CATALOGUE.filter((entry) => entry.status === 409).map((e) => e.kind)).toEqual([
      "version_conflict",
    ]);
  });
});

describe("typed details", () => {
  it("expose the conventional keys", async () => {
    const conflict = toDbError(
      await raised(
        "version_conflict",
        "idea 1 is at version 4, not 3",
        { latest_version: 4, expected_version: 3 },
        null,
      ),
    ) as VersionConflictError;
    expect(conflict.latestVersion).toBe(4);
    expect(conflict.hint).toBeUndefined();

    const transition = toDbError(
      await raised(
        "invalid_transition",
        "cannot move",
        { from: "inbox", to: "editing", allowed: ["shortlisted", "dropped"] },
        null,
      ),
    ) as InvalidTransitionError;
    expect(transition.allowed).toEqual(["shortlisted", "dropped"]);

    const validation = toDbError(
      await raised(
        "validation",
        "bad kind",
        { field: "kind", value: "x", allowed: ["script", "packaging"] },
        null,
      ),
    ) as ValidationError;
    expect(validation.field).toBe("kind");
    expect(validation.allowed).toEqual(["script", "packaging"]);

    const missing = toDbError(
      await raised("not_found", "no idea 9", { entity: "idea", id: "9" }, null),
    ) as NotFoundError;
    expect([missing.entity, missing.id]).toEqual(["idea", "9"]);

    const duplicate = toDbError(
      await raised("duplicate", "video exists", { entity: "video", existing_id: "v1" }, null),
    ) as DuplicateError;
    expect(duplicate.existingId).toBe("v1");
  });

  it("tolerate missing or malformed values", async () => {
    const err = toDbError(
      await raised("version_conflict", "stale", { latest_version: "four" }, null),
    );
    expect((err as VersionConflictError).latestVersion).toBeUndefined();
    const plain = toDbError(await raised("validation", "bad", [1, 2], null)) as ValidationError;
    expect(plain.details).toEqual({ value: [1, 2] });
    expect(plain.allowed).toBeUndefined();
  });

  it("render as JSON and as text for an LLM", () => {
    const err = new VersionConflictError("idea 1 changed; latest version is 4", {
      latest_version: 4,
    });
    expect(err).toMatchObject({ kind: "version_conflict", sqlstate: "YT004", status: 409 });
    expect(err.latestVersion).toBe(4);
    expect(err.toJSON()).toEqual({
      error: "version_conflict",
      message: "idea 1 changed; latest version is 4",
      details: { latest_version: 4 },
    });
    expect(formatDbError(err)).toBe(
      'idea 1 changed; latest version is 4\nDetails: {"latest_version":4}',
    );
    const hinted = new ForbiddenError("not an admin", {}, "ask an admin");
    expect(formatDbError(hinted)).toBe("not an admin\nHint: ask an admin");
    expect(hinted.toJSON()).toMatchObject({ hint: "ask an admin" });
    expect(formatAllowed(["inbox", "dropped"])).toBe('"inbox", "dropped"');
  });
});

describe("toDbError", () => {
  it("leaves errors outside the catalogue untouched", async () => {
    const divide = await failure(db.admin.query("SELECT 1 FROM (VALUES (1)) v (x) WHERE x = 1/0"));
    expect(toDbError(divide)).toBe(divide);
    const plain = new Error("boom");
    expect(toDbError(plain)).toBe(plain);
    const already = new ImmutableError("no");
    expect(toDbError(already)).toBe(already);
    const nodeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(isPgError(nodeError)).toBe(false);
    expect(toDbError("text")).toBe("text");
    expect(dbErrorKind("YT004")).toBe("version_conflict");
    expect(dbErrorKind("23505")).toBeUndefined();
  });

  it("keeps a non-JSON detail as text", () => {
    const pgLike = Object.assign(new Error("odd"), {
      code: "YT001",
      severity: "ERROR",
      detail: "plain words",
    });
    expect((toDbError(pgLike) as DbError).details).toEqual({ detail: "plain words" });
  });

  it("is reached by ytw_raise only with known kinds", async () => {
    const err = await failure(db.admin.query("SELECT ytw_raise('oops', 'x')"));
    expect(err.message).toMatch(/unknown error kind 'oops'/);
    expect(toDbError(err)).toBe(err);
  });
});
