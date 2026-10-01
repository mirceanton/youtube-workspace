import { describe, expect, it } from "vitest";
import {
  MAX_REDACT_DEPTH,
  REDACTED,
  createLineScrubber,
  createStringScrubber,
  isSensitiveKey,
  redact,
  scrubString,
} from "../src/index.js";
import { SECRET, findLeaks } from "./helpers.js";

describe("isSensitiveKey", () => {
  it.each([
    "authorization",
    "Authorization",
    "proxy-authorization",
    "cookie",
    "Cookie",
    "set-cookie",
    "Set-Cookie",
    "cookies",
    "password",
    "newPassword",
    "db_password",
    "secret",
    "client_secret",
    "clientSecret",
    "SESSION_SECRET",
    "OIDC_CLIENT_SECRET",
    "token",
    "access_token",
    "accessToken",
    "refresh_token",
    "id_token",
    "idToken",
    "bearerToken",
    "x-csrf-token",
    "x-api-key",
    "apiKey",
    "api_key",
    "privateKey",
    "session_id",
    "sid",
    "code_verifier",
    "tokenHash",
    "token_hash",
    "tokens",
  ])("treats %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "tokenId",
    "token_id",
    "tokenName",
    "token_name",
    "tokenPrefix",
    "tokenOwnerUsername",
    "actor",
    "actorType",
    "reqId",
    "statusCode",
    "url",
    "method",
    "idea_id",
    "version",
    "code",
    "err",
    "authenticated",
    "user-agent",
    "x-request-id",
    "content-type",
    "",
  ])("leaves %s alone", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("redact", () => {
  it("replaces sensitive keys at the top level and keeps the rest", () => {
    expect(
      redact({ authorization: `Bearer ${SECRET.apiToken}`, actor: "owner", status: 200 }),
    ).toEqual({ authorization: REDACTED, actor: "owner", status: 200 });
  });

  it("redacts at any depth, through objects and arrays", () => {
    const input = {
      a: { b: { c: { d: { e: { password: SECRET.password, keep: "yes" } } } } },
      list: [{ headers: { Authorization: SECRET.opaqueBearer } }, { ok: true }],
      deepList: [[[{ cookie: SECRET.sessionCookie }]]],
    };
    const output = JSON.stringify(redact(input));
    expect(output).not.toContain(SECRET.password);
    expect(output).not.toContain(SECRET.opaqueBearer);
    expect(output).not.toContain(SECRET.sessionCookie);
    expect(redact(input)).toEqual({
      a: { b: { c: { d: { e: { password: REDACTED, keep: "yes" } } } } },
      list: [{ headers: { Authorization: REDACTED } }, { ok: true }],
      deepList: [[[{ cookie: REDACTED }]]],
    });
  });

  it("redacts the whole subtree under a sensitive key and keeps null as null", () => {
    expect(redact({ cookies: { a: "1", b: { c: "2" } }, password: null })).toEqual({
      cookies: REDACTED,
      password: null,
    });
  });

  it("does not mutate its input", () => {
    const input = { headers: { authorization: "Bearer abcdefghijkl" }, n: 1 };
    const snapshot = JSON.stringify(input);
    redact(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("keeps descriptive token fields so the audit trail stays readable", () => {
    expect(
      redact({ tokenId: "7a1c", tokenName: "analytics-agent", tokenPrefix: "ytw_Zq8v" }),
    ).toEqual({ tokenId: "7a1c", tokenName: "analytics-agent", tokenPrefix: "ytw_Zq8v" });
  });

  it("scrubs secret-shaped values inside strings under ordinary keys", () => {
    const output = redact({
      message: `calling with Bearer ${SECRET.opaqueBearer} now`,
      note: `token is ${SECRET.apiToken}`,
      jwt: SECRET.jwt,
    });
    expect(JSON.stringify(output)).not.toContain(SECRET.opaqueBearer);
    expect(JSON.stringify(output)).not.toContain(SECRET.apiToken);
    expect(JSON.stringify(output)).not.toContain(SECRET.jwt);
  });

  it("converts errors to plain objects, scrubbing the message, stack and own properties", () => {
    const cause = new Error(`upstream rejected ${SECRET.apiToken}`);
    const error = Object.assign(new Error(`failed with Bearer ${SECRET.opaqueBearer}`, { cause }), {
      config: { headers: { Authorization: SECRET.opaqueBearer } },
      code: "E_FAIL",
    });
    const output = redact(error) as Record<string, unknown>;
    const text = JSON.stringify(output);
    expect(text).not.toContain(SECRET.opaqueBearer);
    expect(text).not.toContain(SECRET.apiToken);
    expect(output["type"]).toBe("Error");
    expect(output["code"]).toBe("E_FAIL");
    expect(output["message"]).toContain("failed with Bearer");
    expect(String(output["stack"])).toContain("Error:");
    expect((output["cause"] as Record<string, unknown>)["message"]).toContain("upstream rejected");
  });

  it("handles circular references", () => {
    const node: Record<string, unknown> = { name: "root", password: SECRET.password };
    node["self"] = node;
    node["child"] = { parent: node };
    const output = redact(node) as Record<string, unknown>;
    expect(output["self"]).toBe("[Circular]");
    expect((output["child"] as Record<string, unknown>)["parent"]).toBe("[Circular]");
    expect(JSON.stringify(output)).not.toContain(SECRET.password);
  });

  it("does not call a shared (non-circular) object circular", () => {
    const shared = { value: 1 };
    expect(redact({ a: shared, b: shared })).toEqual({ a: { value: 1 }, b: { value: 1 } });
  });

  it("truncates excessive depth instead of emitting it unscanned", () => {
    let nested: Record<string, unknown> = { password: SECRET.password };
    for (let i = 0; i < MAX_REDACT_DEPTH + 5; i++) nested = { next: nested };
    const text = JSON.stringify(redact(nested));
    expect(text).toContain("[Truncated]");
    expect(text).not.toContain(SECRET.password);
  });

  it("replaces binary data with a size marker", () => {
    expect(redact({ body: Buffer.from(SECRET.password), view: new Uint8Array(4) })).toEqual({
      body: `[Binary ${SECRET.password.length} bytes]`,
      view: "[Binary 4 bytes]",
    });
  });

  it("survives getters that throw", () => {
    const hostile = {
      ok: 1,
      get boom(): string {
        throw new Error("nope");
      },
    };
    expect(redact(hostile)).toEqual({ ok: 1, boom: "[Unserializable]" });
  });

  it("keeps a __proto__ key as plain data", () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}') as unknown;
    const output = redact(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(output["x"]).toBe(1);
  });

  it("walks Maps, Sets, Headers, URLs and URLSearchParams", () => {
    const output = redact({
      map: new Map([["authorization", SECRET.opaqueBearer]]),
      set: new Set([`Bearer ${SECRET.opaqueBearer}`]),
      headers: new Headers({ Authorization: SECRET.opaqueBearer, "x-request-id": "r1" }),
      url: new URL(`https://example.test/cb?code=${SECRET.oidcCode}&ok=1`),
      params: new URLSearchParams({ access_token: SECRET.jwt, page: "2" }),
      when: new Date("2026-10-01T00:00:00Z"),
    });
    const text = JSON.stringify(output);
    for (const secret of [SECRET.opaqueBearer, SECRET.oidcCode, SECRET.jwt]) {
      expect(text).not.toContain(secret);
    }
    expect(output).toMatchObject({
      map: { authorization: REDACTED },
      headers: { authorization: REDACTED, "x-request-id": "r1" },
      params: { access_token: REDACTED, page: "2" },
      when: new Date("2026-10-01T00:00:00Z"),
    });
  });

  it("treats code, state and similar as credentials inside query and form parameters only", () => {
    const callback = { code: SECRET.oidcCode, state: SECRET.oidcState, page: "2" };
    const output = redact({
      query: callback,
      request: { querystring: callback },
      params: new URLSearchParams(`code=${SECRET.oidcCode}&state=${SECRET.oidcState}`),
      // Elsewhere the same names are ordinary fields.
      error: { code: "ENOENT" },
      idea: { state: "published", code: 7 },
    });
    expect(findLeaks(JSON.stringify(output))).toEqual([]);
    expect(output).toEqual({
      query: { code: REDACTED, state: REDACTED, page: "2" },
      request: { querystring: { code: REDACTED, state: REDACTED, page: "2" } },
      params: { code: REDACTED, state: REDACTED },
      error: { code: "ENOENT" },
      idea: { state: "published", code: 7 },
    });
  });

  it("treats code and state as credentials under callback and OAuth style containers", () => {
    const pair = { code: SECRET.oidcCode, state: SECRET.oidcState };
    const output = redact({
      callback: pair,
      oidcResponse: { result: pair },
      oauth: pair,
      redirectParams: pair,
      authFlow: { callbackQuery: pair },
      format: { code: 7 },
    });
    expect(findLeaks(JSON.stringify(output))).toEqual([]);
    expect(output).toMatchObject({ format: { code: 7 } });
  });

  it("treats encryption, signing and HMAC keys as sensitive", () => {
    const keys = ["encryptionKey", "signing_key", "hmacKey", "masterKey", "ENCRYPTION-KEY"];
    expect(keys.map((key) => isSensitiveKey(key))).toEqual(keys.map(() => true));
    expect(isSensitiveKey("keyboard")).toBe(false);
  });

  it("recognises a header name/value list wherever it appears, not only under rawHeaders", () => {
    const flat = ["Host", "example.test", "Cookie", SECRET.sessionCookie];
    const output = redact({
      anything: flat,
      nested: [flat],
      pairs: [["authorization", SECRET.opaqueBearer]],
    });
    expect(findLeaks(JSON.stringify(output))).toEqual([]);
    expect(redact(flat)).toEqual(["Host", "example.test", "Cookie", REDACTED]);
    expect(redact(["red", "green", "blue"])).toEqual(["red", "green", "blue"]);
  });

  it("redacts the value after a sensitive name in Node's flat rawHeaders list", () => {
    const rawHeaders = [
      "Host",
      "example.test",
      "Authorization",
      SECRET.opaqueBearer,
      "Cookie",
      "a=b",
    ];
    expect(redact({ rawHeaders })).toEqual({
      rawHeaders: ["Host", "example.test", "Authorization", REDACTED, "Cookie", REDACTED],
    });
  });

  it("passes primitives through", () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(true)).toBe(true);
    expect(redact("plain text")).toBe("plain text");
  });
});

describe("scrubString", () => {
  it("removes bearer credentials", () => {
    expect(scrubString(`Authorization header was Bearer ${SECRET.opaqueBearer}`)).toBe(
      `Authorization header was Bearer ${REDACTED}`,
    );
  });

  it("leaves prose that merely contains the word Bearer", () => {
    expect(scrubString("missing Bearer authorization header")).toBe(
      "missing Bearer authorization header",
    );
  });

  it("removes ytw_ API tokens but not database object names", () => {
    expect(scrubString(`token ${SECRET.apiToken} used`)).toBe(`token ${REDACTED} used`);
    const identifiers = "function ytw_save_script_version does not exist; role ytw_readonly";
    expect(scrubString(identifiers)).toBe(identifiers);
  });

  it("removes JWTs", () => {
    expect(scrubString(`id_token ${SECRET.jwt} end`)).toBe(`id_token ${REDACTED} end`);
  });

  it("removes passwords from connection strings and URLs", () => {
    expect(
      scrubString(`connect postgres://ytw_web:${SECRET.dbPassword}@db.internal:5432/ytw failed`),
    ).toBe(`connect postgres://ytw_web:${REDACTED}@db.internal:5432/ytw failed`);
    expect(scrubString("http://example.test:8080/path")).toBe("http://example.test:8080/path");
  });

  it("removes credentials from query strings and fragments, keeping other parameters", () => {
    const url = `/auth/callback?code=${SECRET.oidcCode}&state=${SECRET.oidcState}&page=2#access_token=${SECRET.jwt}`;
    expect(scrubString(url)).toBe(
      `/auth/callback?code=${REDACTED}&state=${REDACTED}&page=2#access_token=${REDACTED}`,
    );
  });

  it("removes Cookie and Authorization header text", () => {
    expect(scrubString(`cookie: ${SECRET.sessionCookie}`)).toBe(`cookie: ${REDACTED}`);
    expect(scrubString("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(
      `Authorization: ${REDACTED}`,
    );
  });

  it("removes credentials assigned in free text: key=value pairs and JSON dumped into a message", () => {
    expect(scrubString(`host=db user=ytw_web password=${SECRET.dbPassword} dbname=ytw`)).toBe(
      `host=db user=ytw_web password=${REDACTED} dbname=ytw`,
    );
    expect(scrubString(`grant refresh_token=${SECRET.jwt}&grant_type=refresh`)).toBe(
      `grant refresh_token=${REDACTED}&grant_type=refresh`,
    );
    expect(scrubString(`DB_PASSWORD="${SECRET.dbPassword}"`)).toBe(`DB_PASSWORD="${REDACTED}"`);
    const dumped = JSON.stringify({
      user: "owner",
      password: SECRET.password,
      client_secret: SECRET.clientSecret,
    });
    const cleaned = scrubString(`body was ${dumped}`);
    expect(cleaned).not.toContain(SECRET.password);
    expect(cleaned).not.toContain(SECRET.clientSecret);
    expect(cleaned).toContain('"user":"owner"');
  });

  it("judges assigned names by the same rule as object keys, in any naming style", () => {
    const dumped = JSON.stringify({
      refreshToken: SECRET.opaqueBearer,
      clientSecret: SECRET.clientSecret,
      "x-api-key": SECRET.apiToken,
      encryptionKey: SECRET.password,
      hmacKey: SECRET.dbPassword,
      signingKey: SECRET.oidcState,
      name: "kept",
    });
    const cleaned = scrubString(
      `payload ${dumped} and appSecret=${SECRET.literal} sessionToken=${SECRET.jwt}`,
    );
    expect(findLeaks(cleaned)).toEqual([]);
    expect(cleaned).not.toContain(SECRET.literal);
    expect(cleaned).toContain('"name":"kept"');
  });

  it("keeps scanning inside the value of a harmless name", () => {
    expect(scrubString(`msg="retry password=${SECRET.dbPassword} now" attempt=2`)).toBe(
      `msg="retry password=${REDACTED} now" attempt=2`,
    );
  });

  it("redacts an unterminated quoted value to the end, to fail closed", () => {
    expect(scrubString(`password="${SECRET.password} and more`)).toBe(`password="${REDACTED}`);
  });

  it("leaves look-alike names and prose alone", () => {
    for (const text of [
      "max_tokens=100 tokenizer=bpe",
      "password: required",
      "tokenId=7a1c tokenName=analytics-agent",
      "state=ready code=ENOENT",
    ]) {
      expect(scrubString(text)).toBe(text);
    }
  });

  it("is idempotent", () => {
    const once = scrubString(
      `Bearer ${SECRET.opaqueBearer} ${SECRET.apiToken} ?code=${SECRET.oidcCode}`,
    );
    expect(scrubString(once)).toBe(once);
  });
});

describe("createStringScrubber", () => {
  it("removes registered literal secrets in plain and JSON-escaped form", () => {
    const tricky = 'quote"back\\slash-secret-value';
    const scrub = createStringScrubber([SECRET.literal, tricky]);
    expect(scrub(`value=${SECRET.literal}!`)).toBe(`value=${REDACTED}!`);
    expect(scrub(`raw ${tricky} end`)).toBe(`raw ${REDACTED} end`);
    const jsonLine = JSON.stringify({ msg: `leaked ${tricky}` });
    expect(scrub(jsonLine)).not.toContain("back");
    expect(JSON.parse(scrub(jsonLine))).toEqual({ msg: `leaked ${REDACTED}` });
  });

  it("removes a literal in full even when a pattern would only match part of it", () => {
    const awkward = "Bearer-style secret with spaces!and-symbols-12345";
    const scrub = createStringScrubber([awkward]);
    const out = scrub(`header Bearer ${awkward} sent`);
    expect(out).not.toContain("symbols");
    expect(out).not.toContain("spaces");
  });

  it("has a line variant that never changes the structure of a JSON line", () => {
    const line = JSON.stringify({
      token: null,
      password: "[REDACTED]",
      n: 1,
      msg: "password=abc12345",
    });
    const scrubbed = createLineScrubber([SECRET.literal])(line);
    expect(JSON.parse(scrubbed)).toEqual({
      token: null,
      password: REDACTED,
      n: 1,
      msg: `password=${REDACTED}`,
    });
  });

  it("ignores values too short to be real secrets", () => {
    const scrub = createStringScrubber(["abc", ""]);
    expect(scrub("abc and everything else")).toBe("abc and everything else");
  });
});
