import {
  CSRF_HEADER as SHARED_CSRF_HEADER,
  LOGIN_PATH as SHARED_LOGIN_PATH,
  LOGOUT_PATH as SHARED_LOGOUT_PATH,
  ME_PATH as SHARED_ME_PATH,
  RETURN_TO_PARAM as SHARED_RETURN_TO_PARAM,
  meResponseSchema,
} from "@ytw/shared/api/session";
import {
  NOTE_BODY_MAX_BYTES as SHARED_NOTE_BODY_MAX_BYTES,
  NOTES_PATH as SHARED_NOTES_PATH,
} from "@ytw/shared/api/notes";
import { describe, expect, it } from "vitest";
import {
  CSRF_HEADER,
  LOGIN_PATH,
  LOGOUT_PATH,
  ME_PATH,
  NOTE_BODY_MAX_BYTES,
  NOTES_PATH,
  RETURN_TO_PARAM,
} from "../../src/lib/contract.ts";
import { parseMe } from "../../src/lib/session.ts";

// The shell validates /api/me without zod (keeps zod out of the initial bundle). This makes sure
// that hand-written check and the shared zod schema, which the server validates with, accept and
// reject the same bodies, and that the copied constants have not drifted.

const valid = {
  user: { id: "u1", username: "owner", displayName: "Owner", email: "o@x.test", isAdmin: true },
  levels: {
    ideas: "write",
    scripts: "write",
    experiments: "read",
    videos: "read",
    notes: "write",
    activity: "read",
  },
};

function withUser(patch: object) {
  return { ...valid, user: { ...valid.user, ...patch } };
}

function withLevels(patch: object) {
  return { ...valid, levels: { ...valid.levels, ...patch } };
}

const CASES: [string, unknown][] = [
  ["valid", valid],
  ["not an object", "nope"],
  ["no user", { levels: valid.levels }],
  ["no levels", { user: valid.user }],
  ["empty id", withUser({ id: "" })],
  ["empty username", withUser({ username: "" })],
  ["empty displayName is fine", withUser({ displayName: "" })],
  ["missing email", withUser({ email: undefined })],
  ["isAdmin as string", withUser({ isAdmin: "true" })],
  ["missing level", withLevels({ notes: undefined })],
  ["unknown level word", withLevels({ ideas: "admin" })],
  ["write on activity", withLevels({ activity: "write" })],
  ["unknown resource", withLevels({ comments: "write" })],
];

describe("/api/me: the zod-free check matches the shared schema", () => {
  it.each(CASES)("%s", (_name, body) => {
    let shell = true;
    try {
      parseMe(body);
    } catch {
      shell = false;
    }
    expect(shell).toBe(meResponseSchema.safeParse(body).success);
  });

  it("returns the same data as zod", () => {
    expect(parseMe(valid)).toEqual(meResponseSchema.parse(valid));
  });
});

describe("contract constants", () => {
  it("equal the ones the server imports from @ytw/shared", () => {
    const web = [ME_PATH, LOGIN_PATH, LOGOUT_PATH, RETURN_TO_PARAM, CSRF_HEADER, NOTES_PATH];
    expect([...web, NOTE_BODY_MAX_BYTES]).toEqual([
      SHARED_ME_PATH,
      SHARED_LOGIN_PATH,
      SHARED_LOGOUT_PATH,
      SHARED_RETURN_TO_PARAM,
      SHARED_CSRF_HEADER,
      SHARED_NOTES_PATH,
      SHARED_NOTE_BODY_MAX_BYTES,
    ]);
  });
});
