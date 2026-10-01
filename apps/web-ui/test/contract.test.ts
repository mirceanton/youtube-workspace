import {
  CSRF_HEADER as SHARED_CSRF_HEADER,
  LOGIN_PATH as SHARED_LOGIN_PATH,
  LOGOUT_PATH as SHARED_LOGOUT_PATH,
  ME_PATH as SHARED_ME_PATH,
  RETURN_TO_PARAM as SHARED_RETURN_TO_PARAM,
  meResponseSchema,
} from "@ytw/shared/api/session";
import { RESOURCES } from "@ytw/shared/constants";
import { describe, expect, it } from "vitest";
import {
  CSRF_HEADER,
  LOGIN_PATH,
  LOGOUT_PATH,
  ME_PATH,
  RETURN_TO_PARAM,
} from "../src/lib/contract.ts";
import { parseMe } from "../src/lib/session.ts";
import { PERSONAS } from "../src/dev/mock-api.ts";

// The shell validates /api/me without zod (keeps zod out of the initial bundle). These tests make
// sure that hand-written check and the shared zod schema, which the web server validates with,
// accept and reject exactly the same bodies.

const valid = {
  user: {
    id: "u1",
    username: "owner",
    displayName: "Owner",
    email: "o@example.test",
    isAdmin: true,
  },
  levels: {
    ideas: "write",
    scripts: "write",
    experiments: "read",
    videos: "read",
    notes: "write",
    activity: "read",
  },
};

function mutate(patch: (body: typeof valid) => unknown): unknown {
  return patch(structuredClone(valid));
}

const CASES: [string, unknown][] = [
  ["valid", valid],
  ["not an object", "nope"],
  ["null", null],
  ["array", []],
  ["no user", { levels: valid.levels }],
  ["no levels", { user: valid.user }],
  ["empty id", mutate((b) => ({ ...b, user: { ...b.user, id: "" } }))],
  ["numeric id", mutate((b) => ({ ...b, user: { ...b.user, id: 7 } }))],
  ["empty username", mutate((b) => ({ ...b, user: { ...b.user, username: "" } }))],
  ["missing displayName", mutate((b) => ({ ...b, user: { ...b.user, displayName: undefined } }))],
  ["empty displayName is fine", mutate((b) => ({ ...b, user: { ...b.user, displayName: "" } }))],
  ["missing email", mutate((b) => ({ ...b, user: { ...b.user, email: undefined } }))],
  ["isAdmin as string", mutate((b) => ({ ...b, user: { ...b.user, isAdmin: "true" } }))],
  ["missing level", mutate((b) => ({ ...b, levels: { ...b.levels, notes: undefined } }))],
  ["unknown level word", mutate((b) => ({ ...b, levels: { ...b.levels, ideas: "admin" } }))],
  ["write on activity", mutate((b) => ({ ...b, levels: { ...b.levels, activity: "write" } }))],
  [
    "unknown resource (new object type)",
    mutate((b) => ({ ...b, levels: { ...b.levels, comments: "write" } })),
  ],
  ["levels as array", mutate((b) => ({ ...b, levels: ["read"] }))],
  ...Object.entries(PERSONAS).flatMap(([name, me]): [string, unknown][] =>
    me ? [[`persona ${name}`, me]] : [],
  ),
];

describe("/api/me: zod-free check in the shell matches the shared schema", () => {
  it.each(CASES)("%s", (_name, body) => {
    const zod = meResponseSchema.safeParse(body);
    let shell = true;
    try {
      parseMe(body);
    } catch {
      shell = false;
    }
    expect(shell).toBe(zod.success);
  });

  it("returns the same data as zod for a valid body", () => {
    expect(parseMe(valid)).toEqual(meResponseSchema.parse(valid));
  });

  it("covers every resource the shared package knows", () => {
    expect(Object.keys(valid.levels).toSorted()).toEqual([...RESOURCES].toSorted());
  });
});

describe("web contract constants", () => {
  it("are identical to the ones the web server imports from @ytw/shared", () => {
    expect({ ME_PATH, LOGIN_PATH, LOGOUT_PATH, RETURN_TO_PARAM, CSRF_HEADER }).toEqual({
      ME_PATH: SHARED_ME_PATH,
      LOGIN_PATH: SHARED_LOGIN_PATH,
      LOGOUT_PATH: SHARED_LOGOUT_PATH,
      RETURN_TO_PARAM: SHARED_RETURN_TO_PARAM,
      CSRF_HEADER: SHARED_CSRF_HEADER,
    });
  });
});
