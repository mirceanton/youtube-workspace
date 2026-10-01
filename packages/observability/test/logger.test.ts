import { describe, expect, it } from "vitest";
import { REDACTED, secretValuesFromEnv } from "../src/index.js";
import { SECRET, findLeaks, memoryLogger } from "./helpers.js";

describe("createLogger output", () => {
  it("emits JSON lines with ISO time, string level, service, version and commit", () => {
    const { logger, sink } = memoryLogger();
    logger.info({ ideaId: "i-1" }, "idea created");
    const [record] = sink.records;
    expect(record).toMatchObject({
      level: "info",
      service: "mcp",
      version: "1.2.3",
      commit: "abc1234",
      msg: "idea created",
      ideaId: "i-1",
    });
    expect(String(record?.["time"])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(typeof record?.["pid"]).toBe("number");
  });

  it("honours the level", () => {
    const { logger, sink } = memoryLogger({ level: "warn" });
    logger.info("hidden");
    logger.warn("shown");
    expect(sink.records.map((r) => r["msg"])).toEqual(["shown"]);
  });

  it("is silent at level silent", () => {
    const { logger, sink } = memoryLogger({ level: "silent" });
    logger.fatal("nothing");
    expect(sink.lines).toEqual([]);
  });
});

describe("secrets are absent from emitted log lines", () => {
  it("removes sensitive headers from a logged request, in any casing", () => {
    const { logger, sink } = memoryLogger();
    logger.info(
      {
        headers: {
          Authorization: `Bearer ${SECRET.apiToken}`,
          authorization: `Bearer ${SECRET.apiToken}`,
          Cookie: SECRET.sessionCookie,
          "Set-Cookie": [SECRET.sessionCookie, `${SECRET.sessionCookie}; Path=/`],
          "X-API-Key": SECRET.clientSecret,
          "x-csrf-token": SECRET.opaqueBearer,
          "x-request-id": "req-1",
          "user-agent": "agent/1.0",
        },
      },
      "incoming",
    );
    expect(findLeaks(sink.text)).toEqual([]);
    expect(sink.records[0]?.["headers"]).toMatchObject({
      Authorization: REDACTED,
      Cookie: REDACTED,
      "Set-Cookie": REDACTED,
      "X-API-Key": REDACTED,
      "x-request-id": "req-1",
      "user-agent": "agent/1.0",
    });
  });

  it("removes secrets nested deep inside objects and arrays", () => {
    const { logger, sink } = memoryLogger();
    logger.info({
      request: {
        meta: {
          upstream: [
            { response: { headers: { "set-cookie": SECRET.sessionCookie } } },
            { auth: { access_token: SECRET.jwt, refresh_token: SECRET.opaqueBearer } },
          ],
        },
        body: { user: { profile: { password: SECRET.password, name: "Owner" } } },
      },
      oidc: { client_secret: SECRET.clientSecret, id_token: SECRET.jwt },
    });
    expect(findLeaks(sink.text)).toEqual([]);
    expect(sink.text).toContain("Owner");
  });

  it("removes secrets from child logger bindings, at any child depth", () => {
    const { logger, sink } = memoryLogger();
    const child = logger.child({ authorization: `Bearer ${SECRET.apiToken}`, component: "auth" });
    child.info("with bindings");
    const grandchild = child.child({ session: { cookie: SECRET.sessionCookie }, step: 2 });
    grandchild.info("with nested bindings");
    expect(findLeaks(sink.text)).toEqual([]);
    expect(sink.records[0]).toMatchObject({ component: "auth", authorization: REDACTED });
    expect(sink.records[1]).toMatchObject({
      component: "auth",
      authorization: REDACTED,
      session: { cookie: REDACTED },
      step: 2,
    });
  });

  it("removes secrets interpolated into the message", () => {
    const { logger, sink } = memoryLogger();
    logger.info(`calling upstream with Bearer ${SECRET.opaqueBearer}`);
    logger.warn({ ok: false }, `token ${SECRET.apiToken} rejected, jwt ${SECRET.jwt}`);
    logger.info(`conninfo host=db password=${SECRET.dbPassword} dbname=ytw`);
    logger.info(`login body ${JSON.stringify({ user: "owner", password: SECRET.password })}`);
    expect(findLeaks(sink.text)).toEqual([]);
    expect(sink.records).toHaveLength(4);
    expect(sink.records[3]?.["msg"]).toContain('"user":"owner"');
  });

  it("removes secrets passed as format arguments", () => {
    const { logger, sink } = memoryLogger();
    logger.info("payload %j and %s", { password: SECRET.password, id: 7 }, SECRET.apiToken);
    logger.info("raw %s", `Bearer ${SECRET.opaqueBearer}`);
    expect(findLeaks(sink.text)).toEqual([]);
    expect(sink.records[0]?.["msg"]).toBe(
      `payload {"password":"${REDACTED}","id":7} and ${REDACTED}`,
    );
  });

  it("removes secrets from errors: message, stack, cause and attached request config", () => {
    const { logger, sink } = memoryLogger();
    const cause = new Error(`connect postgres://ytw_web:${SECRET.dbPassword}@db:5432/ytw refused`);
    const error = Object.assign(
      new Error(`auth failed for Bearer ${SECRET.opaqueBearer}`, { cause }),
      {
        config: {
          headers: { Authorization: `Bearer ${SECRET.apiToken}` },
          url: "https://api.test/x",
        },
        response: { headers: { "set-cookie": SECRET.sessionCookie } },
      },
    );
    logger.error({ err: error }, "request failed");
    logger.error(error);
    logger.error(error, `again: ${SECRET.jwt}`);
    expect(findLeaks(sink.text)).toEqual([]);
    const first = sink.records[0] as { err: Record<string, unknown> };
    expect(first.err["type"]).toBe("Error");
    expect(String(first.err["message"])).toContain("auth failed");
    expect(String(first.err["stack"])).toContain("Error:");
    expect(first.err["config"]).toMatchObject({ url: "https://api.test/x" });
    expect((first.err["cause"] as Record<string, unknown>)["message"]).toContain("refused");
  });

  it("removes credentials from request URLs, including OIDC callback parameters", () => {
    const { logger, sink } = memoryLogger();
    logger.info(
      {
        req: {
          method: "GET",
          url: `/auth/callback?code=${SECRET.oidcCode}&state=${SECRET.oidcState}&session_state=zz`,
          headers: { authorization: `Bearer ${SECRET.apiToken}` },
        },
      },
      "incoming request",
    );
    logger.info({ url: `/x?access_token=${SECRET.jwt}&page=1` }, "other url field");
    expect(findLeaks(sink.text)).toEqual([]);
    const req = (sink.records[0] ?? {})["req"] as Record<string, unknown>;
    expect(req["method"]).toBe("GET");
    expect(String(req["url"])).toMatch(/^\/auth\/callback\?code=\[REDACTED\]&state=\[REDACTED\]/);
    expect(req).not.toHaveProperty("headers");
  });

  it("removes literal secrets registered at startup, wherever they appear", () => {
    const { logger, sink } = memoryLogger({ secrets: [SECRET.literal] });
    logger.info(
      { note: `value is ${SECRET.literal}`, [SECRET.literal]: "as a key" },
      SECRET.literal,
    );
    logger.info(`again ${SECRET.literal}`);
    expect(sink.text).not.toContain(SECRET.literal);
    expect(sink.records).toHaveLength(2);
  });

  it("collects literal secrets from the environment by variable name", () => {
    const values = secretValuesFromEnv({
      SESSION_SECRET: SECRET.literal,
      OIDC_CLIENT_SECRET: SECRET.clientSecret,
      METRICS_TOKEN: SECRET.opaqueBearer,
      PORT: "3000",
      LOG_LEVEL: "info",
      EMPTY_SECRET: "",
    });
    expect(values.toSorted()).toEqual(
      [SECRET.clientSecret, SECRET.literal, SECRET.opaqueBearer].toSorted(),
    );
  });

  it("keeps every line valid JSON after scrubbing", () => {
    const { logger, sink } = memoryLogger({ secrets: ['we"ird\\secret-value'] });
    logger.info({ a: 'we"ird\\secret-value', b: `Bearer ${SECRET.opaqueBearer}` }, "x");
    logger.info(`Cookie: ${SECRET.sessionCookie}`);
    expect(sink.records).toHaveLength(2);
    expect(sink.text).not.toContain("secret-value");
    expect(findLeaks(sink.text)).toEqual([]);
  });

  it("keeps lines parseable whatever shape the sensitive fields have", () => {
    const { logger, sink } = memoryLogger();
    logger.info(
      {
        token: null,
        password: 12345,
        cookie: { a: 1 },
        secret: ["x", "y"],
        authorization: undefined,
        note: 'say "token=abc123xyz" or {"password":"hunter2"}',
      },
      'msg with "quotes", \\ backslash and password=hunter2',
    );
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      token: null,
      password: REDACTED,
      cookie: REDACTED,
      secret: REDACTED,
    });
    expect(sink.text).not.toContain("hunter2");
    expect(sink.text).not.toContain("abc123xyz");
  });

  it("never throws, even for hostile objects", () => {
    const { logger, sink } = memoryLogger();
    const cyclic: Record<string, unknown> = { password: SECRET.password };
    cyclic["self"] = cyclic;
    const hostile = {
      ok: 1,
      get boom(): string {
        throw new Error("getter failed");
      },
    };
    expect(() => {
      logger.info(hostile, "hostile getter");
      logger.info({ cyclic }, "cycle");
      logger.info({ big: 10n, fn: () => 1, sym: Symbol("s") }, "odd values");
      logger.info(new Proxy({}, { ownKeys: () => [] }), "proxy");
    }).not.toThrow();
    expect(sink.records).toHaveLength(4);
    expect(sink.records[0]).toMatchObject({ ok: 1, boom: "[Unserializable]" });
    expect(findLeaks(sink.text)).toEqual([]);
  });

  it("keeps the fields an operator needs", () => {
    const { logger, sink } = memoryLogger();
    logger.info(
      {
        actor: "analytics-agent",
        actorType: "agent",
        tokenId: "0b1c",
        tokenName: "analytics-agent",
        tool: "log_metrics",
        statusCode: 200,
        responseTime: 12.5,
      },
      "tool call",
    );
    expect(sink.records[0]).toMatchObject({
      actor: "analytics-agent",
      actorType: "agent",
      tokenId: "0b1c",
      tokenName: "analytics-agent",
      tool: "log_metrics",
      statusCode: 200,
      responseTime: 12.5,
    });
  });

  it("applies redaction to custom serializers too", () => {
    const { logger, sink } = memoryLogger({
      serializers: {
        upstream: (value) => ({ raw: value, headers: { cookie: SECRET.sessionCookie } }),
      },
    });
    logger.info({ upstream: `Bearer ${SECRET.opaqueBearer}` }, "custom");
    expect(findLeaks(sink.text)).toEqual([]);
    expect(sink.records).toHaveLength(1);
  });
});

describe("the two redaction layers work independently", () => {
  it("catches a secret under an innocent key by its shape, and a shapeless one by its key", () => {
    const { logger, sink } = memoryLogger();
    logger.info({
      note: `see ${SECRET.apiToken}`,
      credentials: { value: SECRET.password },
    });
    expect(findLeaks(sink.text)).toEqual([]);
    const record = sink.records[0] as Record<string, unknown>;
    expect(record["note"]).toBe(`see ${REDACTED}`);
    expect(record["credentials"]).toBe(REDACTED);
  });
});
