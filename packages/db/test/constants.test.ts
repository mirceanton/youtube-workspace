// The database mirrors some @ytw/shared constants in CHECK constraints and functions; this fails
// when the two drift apart.
import { NOTE_BODY_MAX_BYTES } from "@ytw/shared/api/notes";
import {
  ACTOR_TYPES,
  EXPERIMENT_STATUSES,
  EXPERIMENT_TYPES,
  GRANTABLE_LEVELS,
  IDEA_STAGES,
  IDEA_STAGE_TRANSITIONS,
  LEVELS,
  NOTE_ENTITY_TYPES,
  RESOURCES,
  SCRIPT_BODY_MAX_BYTES,
  SCRIPT_KINDS,
  SCRIPT_STATUSES,
} from "@ytw/shared/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_ERROR_CATALOGUE } from "../src/errors.js";
import { createTestDb, type TestDb } from "../src/testing.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

/** The definition of one constraint, e.g. `CHECK (((status = ANY (ARRAY['inbox'::text, ...` */
async function definition(table: string, constraint: string): Promise<string> {
  const { rows } = await db.pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = $1::regclass AND conname = $2`,
    [table, constraint],
  );
  return rows[0]?.def ?? `no constraint ${constraint}`;
}

/** The text literals of a constraint, sorted. */
async function literals(table: string, constraint: string): Promise<string[]> {
  const def = await definition(table, constraint);
  return [...def.matchAll(/'([^']+)'::text/g)].map((match) => match[1] as string).toSorted();
}

describe("constraints mirror @ytw/shared", () => {
  it.each([
    ["ideas", "ideas_status_check", IDEA_STAGES],
    ["scripts", "scripts_kind_check", SCRIPT_KINDS],
    ["scripts", "scripts_status_check", SCRIPT_STATUSES],
    ["experiments", "experiments_type_check", EXPERIMENT_TYPES],
    ["experiments", "experiments_status_check", EXPERIMENT_STATUSES],
    ["notes", "notes_entity_type_check", NOTE_ENTITY_TYPES],
    ["notes", "notes_actor_type_check", ACTOR_TYPES],
    ["events", "events_actor_type_check", ACTOR_TYPES],
    ["user_permissions", "user_permissions_resource_check", RESOURCES],
    ["user_permissions", "user_permissions_level_check", LEVELS],
    ["ytw_private.api_token_permissions", "api_token_permissions_resource_check", RESOURCES],
    ["ytw_private.api_token_permissions", "api_token_permissions_level_check", LEVELS],
  ])("%s %s", async (table, constraint, expected) => {
    expect(await literals(table, constraint)).toEqual([...expected].toSorted());
  });

  it("limits and the read-only resources", async () => {
    expect(await definition("scripts", "scripts_body_md_size_check")).toContain(
      `<= ${SCRIPT_BODY_MAX_BYTES}`,
    );
    expect(await definition("notes", "notes_body_md_size_check")).toContain(
      `<= ${NOTE_BODY_MAX_BYTES}`,
    );
    const readOnly = RESOURCES.filter((resource) => !GRANTABLE_LEVELS[resource].includes("write"));
    expect(await literals("user_permissions", "user_permissions_read_only_check")).toEqual(
      ["write", ...readOnly].toSorted(),
    );
  });
});

describe("functions mirror @ytw/shared", () => {
  it("lists the resources, their maximum level and the error codes", async () => {
    const { rows } = await db.pool.query<{ resources: string[]; max: Record<string, string> }>(
      `SELECT ytw_resources() AS resources,
              (SELECT jsonb_object_agg(r, ytw_max_level(r)) FROM unnest(ytw_resources()) r) AS max`,
    );
    expect(rows[0]?.resources).toEqual([...RESOURCES]);
    expect(rows[0]?.max).toEqual(
      Object.fromEntries(RESOURCES.map((r) => [r, GRANTABLE_LEVELS[r].at(-1)])),
    );
    const codes = await db.pool.query("SELECT kind, sqlstate FROM ytw_error_codes() ORDER BY 2");
    expect(codes.rows).toEqual(
      DB_ERROR_CATALOGUE.map(({ kind, sqlstate }) => ({ kind, sqlstate })),
    );
  });

  it("has the idea stages and every stage move in the same order", async () => {
    const stages = await db.pool.query("SELECT ytw_idea_stages() AS stages");
    expect(stages.rows[0]).toEqual({ stages: [...IDEA_STAGES] });
    const moves = await db.pool.query(
      `SELECT from_stage AS from, to_stage AS to, kind, requires_note AS "requiresNote"
         FROM ytw_idea_stage_transitions()`,
    );
    expect(moves.rows).toEqual(IDEA_STAGE_TRANSITIONS.map((move) => ({ ...move })));
  });
});
