// Arguments that are NULL or malformed, for every function of migrations 0050-0054 (T14).
//
// In SQL a required argument that is NULL must be answered with a `validation` error that names it,
// never with a not_found about "NULL", a bare driver error or silent success. In the wrappers a
// value Postgres cannot even receive (a malformed UUID, a NUL character) is a ValidationError that
// says which argument is wrong. Messages never repeat more than 60 characters of a caller's value.
import { Buffer } from "node:buffer";
import { RESOURCES } from "@ytw/shared/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor } from "../src/client.js";
import { ValidationError, toDbError } from "../src/errors.js";
import { getUserAccess, setUserAdmin, upsertUserOnLogin } from "../src/identity.js";
import { listUserAccess, setUserPermission } from "../src/permissions.js";
import {
  createWebSession,
  deleteWebSession,
  getWebSession,
  touchWebSession,
  updateWebSessionTokens,
} from "../src/sessions.js";
import {
  createApiToken,
  getApiToken,
  listApiTokens,
  lookupTokenByHash,
  revokeApiToken,
  rotateApiToken,
  touchTokenLastUsed,
  updateTokenPermissions,
} from "../src/tokens.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { failure } from "./helpers.js";
import {
  ISSUER,
  grant,
  login,
  makeToken,
  newSecret,
  person,
  unique,
  type TestUser,
} from "./identity-helpers.js";

let db: TestDb;
let root: TestUser;
let owner: TestUser;

beforeAll(async () => {
  db = await createTestDb();
  root = await login(db, "root");
  owner = await login(db, "owner");
  await grant(db, root, owner, { ideas: "write", scripts: "read" });
});

afterAll(async () => {
  await db.drop();
});

/** One database function with fresh valid arguments (every call gets its own fixtures). */
interface Spec {
  name: string;
  types: readonly string[];
  valid: () => Promise<unknown[]>;
  /** Positions where NULL is a legitimate value. */
  optional: readonly number[];
}

const WEB = () => db.pool("ytw_web");

/** What each call came to when exactly one argument was NULL: `ok` or the database error kind. */
async function nullOutcomes(spec: Spec): Promise<Record<number, string>> {
  const outcomes: Record<number, string> = {};
  const placeholders = spec.types.map((type, index) => `$${index + 1}::${type}`).join(", ");
  for (let position = 0; position < spec.types.length; position += 1) {
    const values = await spec.valid();
    values[position] = null;
    try {
      await WEB().query(`SELECT * FROM public.${spec.name}(${placeholders})`, values);
      outcomes[position] = "ok";
    } catch (err) {
      const kind: unknown = Reflect.get(toDbError(err) as object, "kind");
      outcomes[position] = typeof kind === "string" ? kind : `not a database error: ${String(err)}`;
    }
  }
  return outcomes;
}

function expectedNullOutcomes(spec: Spec): Record<number, string> {
  return Object.fromEntries(
    spec.types.map((_type, position) => [
      position,
      spec.optional.includes(position) ? "ok" : "validation",
    ]),
  );
}

const freshUser = async () => login(db, `arg-${unique()}`);

const SPECS: Spec[] = [
  {
    name: "upsert_user_on_login",
    types: ["text", "text", "uuid", "text", "text", "text", "text", "text"],
    valid: async () => {
      const name = `arg-${unique()}`;
      return [name, "human", null, ISSUER, `sub-${name}`, name, `${name}@example.test`, "A Name"];
    },
    optional: [2, 6, 7],
  },
  {
    name: "set_user_permission",
    types: ["text", "text", "uuid", "uuid", "uuid", "text", "text"],
    valid: async () => ["root", "human", null, root.id, (await freshUser()).id, "ideas", "read"],
    optional: [2],
  },
  {
    name: "set_user_admin",
    types: ["text", "text", "uuid", "uuid", "uuid", "boolean", "boolean"],
    valid: async () => ["root", "human", null, root.id, (await freshUser()).id, true, false],
    optional: [2, 6],
  },
  {
    name: "create_api_token",
    types: ["text", "text", "uuid", "uuid", "text", "text", "text", "timestamptz", "jsonb"],
    valid: async () => {
      const made = newSecret();
      return [
        "owner",
        "human",
        null,
        owner.id,
        `tok-${unique()}`,
        made.prefix,
        made.hash,
        null,
        '{"ideas": "read"}',
      ];
    },
    optional: [2, 7],
  },
  {
    name: "update_token_permissions",
    types: ["text", "text", "uuid", "uuid", "uuid", "jsonb"],
    valid: async () => [
      "owner",
      "human",
      null,
      owner.id,
      (await makeToken(db, owner, {})).token.id,
      '{"ideas": "read"}',
    ],
    optional: [2],
  },
  {
    name: "rotate_api_token",
    types: ["text", "text", "uuid", "uuid", "uuid", "text", "text", "boolean", "timestamptz"],
    valid: async () => {
      const made = newSecret();
      return [
        "owner",
        "human",
        null,
        owner.id,
        (await makeToken(db, owner, {})).token.id,
        made.prefix,
        made.hash,
        false,
        null,
      ];
    },
    optional: [2, 7, 8],
  },
  {
    name: "revoke_api_token",
    types: ["text", "text", "uuid", "uuid", "uuid"],
    valid: async () => [
      "owner",
      "human",
      null,
      owner.id,
      (await makeToken(db, owner, {})).token.id,
    ],
    optional: [2],
  },
  {
    name: "touch_token_last_used",
    types: ["text", "text", "uuid"],
    valid: async () => {
      const made = await makeToken(db, owner, {});
      return [made.token.name, "agent", made.token.id];
    },
    optional: [],
  },
  {
    name: "lookup_token_by_hash",
    types: ["text"],
    valid: async () => [newSecret().hash],
    optional: [],
  },
  {
    name: "create_web_session",
    types: ["uuid", "bytea", "text", "integer", "integer"],
    valid: async () => [owner.id, Buffer.from("ciphertext"), "a.b.c", 3600, 86_400],
    optional: [1, 2],
  },
  {
    name: "touch_web_session",
    types: ["uuid", "integer"],
    valid: async () => {
      const session = await createWebSession(WEB(), {
        userId: owner.id,
        idleTimeoutSeconds: 3600,
        absoluteTimeoutSeconds: 86_400,
      });
      return [session.id, 3600];
    },
    // No session id: nothing to touch, which is an answer (null), not a mistake.
    optional: [0],
  },
  {
    name: "update_web_session_tokens",
    types: ["uuid", "bytea", "text"],
    valid: async () => {
      const session = await createWebSession(WEB(), {
        userId: owner.id,
        idleTimeoutSeconds: 3600,
        absoluteTimeoutSeconds: 86_400,
      });
      return [session.id, Buffer.from("new"), "x.y.z"];
    },
    optional: [0, 1, 2],
  },
];

describe("arguments that are NULL", () => {
  it.each(SPECS)(
    "$name answers a NULL with a validation error wherever a value is required",
    async (spec) => {
      expect(await nullOutcomes(spec)).toEqual(expectedNullOutcomes(spec));
    },
  );

  it("covers every function an application role can call to write (a new one must be listed)", () => {
    expect(SPECS.map((spec) => spec.name).toSorted()).toEqual(
      [
        "upsert_user_on_login",
        "set_user_permission",
        "set_user_admin",
        "create_api_token",
        "update_token_permissions",
        "rotate_api_token",
        "revoke_api_token",
        "touch_token_last_used",
        "lookup_token_by_hash",
        "create_web_session",
        "touch_web_session",
        "update_web_session_tokens",
      ].toSorted(),
    );
  });
});

describe("arguments Postgres cannot receive, caught by the wrappers", () => {
  const NOT_A_UUID = "not-a-uuid";
  const NUL = "bad\u0000value";
  const web = () => WEB();
  const as = (name: string) => person(name);
  const asOwner = <T>(fn: Parameters<typeof withActor<T>>[2]) => withActor(web(), as("owner"), fn);

  const malformed: [string, () => Promise<unknown>, string][] = [
    ["getUserAccess: id", () => getUserAccess(web(), NOT_A_UUID), "user_id"],
    ["listUserAccess: acting user", () => listUserAccess(web(), NOT_A_UUID), "acting_user_id"],
    [
      "setUserPermission: acting user",
      () =>
        withActor(web(), as("root"), (tx) =>
          setUserPermission(tx, {
            actingUserId: NOT_A_UUID,
            userId: owner.id,
            resource: "ideas",
            level: "read",
          }),
        ),
      "acting_user_id",
    ],
    [
      "setUserPermission: user",
      () =>
        withActor(web(), as("root"), (tx) =>
          setUserPermission(tx, {
            actingUserId: root.id,
            userId: NOT_A_UUID,
            resource: "ideas",
            level: "read",
          }),
        ),
      "user_id",
    ],
    [
      "setUserPermission: NUL in the object",
      () =>
        withActor(web(), as("root"), (tx) =>
          setUserPermission(tx, {
            actingUserId: root.id,
            userId: owner.id,
            resource: NUL as never,
            level: "read",
          }),
        ),
      "resource",
    ],
    [
      "setUserAdmin: user",
      () =>
        withActor(web(), as("root"), (tx) =>
          setUserAdmin(tx, { actingUserId: root.id, userId: NOT_A_UUID, isAdmin: true }),
        ),
      "user_id",
    ],
    [
      "upsertUserOnLogin: NUL in the username",
      () =>
        withActor(web(), as("x"), (tx) =>
          upsertUserOnLogin(tx, { issuer: ISSUER, sub: "s", username: NUL }),
        ),
      "username",
    ],
    [
      "upsertUserOnLogin: NUL in the display name",
      () =>
        withActor(web(), as("x"), (tx) =>
          upsertUserOnLogin(tx, { issuer: ISSUER, sub: "s", username: "x", displayName: NUL }),
        ),
      "display_name",
    ],
    [
      "createApiToken: owner",
      () =>
        asOwner((tx) =>
          createApiToken(tx, {
            ownerUserId: NOT_A_UUID,
            name: "n",
            tokenPrefix: "ytw_",
            tokenHash: newSecret().hash,
            expiresAt: null,
            permissions: {},
          }),
        ),
      "owner_user_id",
    ],
    [
      "createApiToken: NUL in the name",
      () =>
        asOwner((tx) =>
          createApiToken(tx, {
            ownerUserId: owner.id,
            name: NUL,
            tokenPrefix: "ytw_",
            tokenHash: newSecret().hash,
            expiresAt: null,
            permissions: {},
          }),
        ),
      "name",
    ],
    [
      "createApiToken: NUL in a permission key",
      () =>
        asOwner((tx) =>
          createApiToken(tx, {
            ownerUserId: owner.id,
            name: "n",
            tokenPrefix: "ytw_",
            tokenHash: newSecret().hash,
            expiresAt: null,
            permissions: { [NUL]: "read" } as never,
          }),
        ),
      "permissions",
    ],
    [
      "createApiToken: NUL in a permission value",
      () =>
        asOwner((tx) =>
          createApiToken(tx, {
            ownerUserId: owner.id,
            name: "n",
            tokenPrefix: "ytw_",
            tokenHash: newSecret().hash,
            expiresAt: null,
            permissions: { ideas: NUL } as never,
          }),
        ),
      "permissions",
    ],
    [
      "updateTokenPermissions: token",
      () =>
        asOwner((tx) =>
          updateTokenPermissions(tx, {
            actingUserId: owner.id,
            apiTokenId: NOT_A_UUID,
            permissions: {},
          }),
        ),
      "api_token_id",
    ],
    [
      "rotateApiToken: NUL in the hash",
      () =>
        asOwner((tx) =>
          rotateApiToken(tx, {
            actingUserId: owner.id,
            apiTokenId: owner.id,
            newTokenPrefix: "ytw_",
            newTokenHash: NUL,
          }),
        ),
      "token_hash",
    ],
    [
      "revokeApiToken: token",
      () => asOwner((tx) => revokeApiToken(tx, { actingUserId: owner.id, apiTokenId: NOT_A_UUID })),
      "api_token_id",
    ],
    ["listApiTokens: owner", () => listApiTokens(web(), NOT_A_UUID), "owner_user_id"],
    ["getApiToken: token", () => getApiToken(web(), owner.id, NOT_A_UUID), "api_token_id"],
    ["lookupTokenByHash: NUL", () => lookupTokenByHash(web(), NUL), "token_hash"],
    [
      "touchTokenLastUsed: token id",
      () => touchTokenLastUsed(web(), { id: NOT_A_UUID, name: "n" }),
      "token_id",
    ],
    [
      "createWebSession: user",
      () =>
        createWebSession(web(), {
          userId: NOT_A_UUID,
          idleTimeoutSeconds: 3600,
          absoluteTimeoutSeconds: 86_400,
        }),
      "user_id",
    ],
    ["touchWebSession: session", () => touchWebSession(web(), NOT_A_UUID, 3600), "session_id"],
    ["getWebSession: session", () => getWebSession(web(), NOT_A_UUID), "session_id"],
    [
      "updateWebSessionTokens: NUL in the hint",
      () => updateWebSessionTokens(web(), owner.id, { idTokenHint: NUL }),
      "id_token_hint",
    ],
    ["deleteWebSession: session", () => deleteWebSession(web(), NOT_A_UUID), "session_id"],
  ];

  it.each(malformed)("%s", async (_label, attempt, field) => {
    const err = await failure(attempt());
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe(field);
  });
});

describe("error messages never repeat a caller's value at length", () => {
  const HUGE = "x".repeat(5000);

  it("an unknown object or level in a permission map is shortened, and a flood of keys is refused", async () => {
    const err = await failure(
      withActor(WEB(), person("owner"), (tx) =>
        createApiToken(tx, {
          ownerUserId: owner.id,
          name: "n",
          tokenPrefix: "ytw_",
          tokenHash: newSecret().hash,
          expiresAt: null,
          permissions: { [HUGE]: "read", ideas: HUGE, scripts: { deep: [HUGE] } } as never,
        }),
      ),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message.length).toBeLessThan(900);
    expect(err.message).toContain("x".repeat(60));
    expect(err.message).not.toContain("x".repeat(61));
    expect(JSON.stringify((err as ValidationError).details).length).toBeLessThan(2500);

    const flood = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`k${index}`, "read"]),
    );
    const flooded = await failure(
      withActor(WEB(), person("owner"), (tx) =>
        createApiToken(tx, {
          ownerUserId: owner.id,
          name: "n",
          tokenPrefix: "ytw_",
          tokenHash: newSecret().hash,
          expiresAt: null,
          permissions: flood as never,
        }),
      ),
    );
    expect(flooded).toBeInstanceOf(ValidationError);
    expect(flooded.message).toBe(
      `permissions names 500 entries, but only ${RESOURCES.length} objects have access levels (${RESOURCES.join(", ")})`,
    );
  });

  it("an unknown object or level given to the access matrix is shortened too", async () => {
    const object = await failure(
      withActor(WEB(), person("root"), (tx) =>
        setUserPermission(tx, {
          actingUserId: root.id,
          userId: owner.id,
          resource: HUGE as never,
          level: "read",
        }),
      ),
    );
    expect(object.message.length).toBeLessThan(400);
    expect(JSON.stringify((object as ValidationError).details).length).toBeLessThan(400);
    const level = await failure(
      withActor(WEB(), person("root"), (tx) =>
        setUserPermission(tx, {
          actingUserId: root.id,
          userId: owner.id,
          resource: "ideas",
          level: HUGE as never,
        }),
      ),
    );
    expect(level.message.length).toBeLessThan(300);
  });
});
