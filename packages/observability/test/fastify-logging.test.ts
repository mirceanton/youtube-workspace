import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { REDACTED, bindActor, fastifyLoggingOptions, requestIdPlugin } from "../src/index.js";
import {
  SECRET,
  closeApps,
  findLeaks,
  memoryLogger,
  trackApp,
  type MemorySink,
} from "./helpers.js";

afterEach(closeApps);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function build(): Promise<{ app: FastifyInstance; sink: MemorySink }> {
  const { logger, sink } = memoryLogger({ secrets: [SECRET.literal] });
  const app = trackApp(Fastify(fastifyLoggingOptions(logger)));
  await app.register(requestIdPlugin);

  app.route({
    method: "GET",
    url: "/items/:id",
    handler: async (request) => {
      request.log.info("handling item");
      return { id: (request.params as { id: string }).id };
    },
  });
  app.route({
    method: "POST",
    url: "/login",
    handler: async (request) => {
      // The worst case: the handler dumps the whole request into the log.
      request.log.info({ headers: request.headers, body: request.body }, "debug dump");
      return { ok: true };
    },
  });
  app.get("/boom", async () => {
    throw new Error(`upstream said Bearer ${SECRET.opaqueBearer} and ${SECRET.literal}`);
  });
  app.get("/actor", async (request, reply) => {
    bindActor(request, reply, {
      actor: "analytics-agent",
      actorType: "agent",
      tokenId: "tok-1",
      tokenName: "analytics-agent",
      ownerId: "user-1",
      ownerUsername: "owner",
    });
    request.log.info("tool call");
    return { ok: true };
  });
  app.get("/actor-twice", async (request, reply) => {
    bindActor(request, reply, { actor: "first", actorType: "agent" });
    bindActor(request, reply, { actor: "second", actorType: "human", userId: "u-1" });
    return { ok: true };
  });
  await app.ready();
  return { app, sink };
}

describe("request ids", () => {
  it("generates a UUID, uses it in the logs and returns it as X-Request-Id", async () => {
    const { app, sink } = await build();
    const res = await app.inject({ method: "GET", url: "/items/7" });
    const id = res.headers["x-request-id"];
    expect(id).toMatch(UUID);
    const records = sink.records.filter((r) => r["reqId"] === id);
    expect(records.map((r) => r["msg"])).toEqual([
      "incoming request",
      "handling item",
      "request completed",
    ]);
  });

  it("accepts a well-formed X-Request-Id from the caller", async () => {
    const { app, sink } = await build();
    const res = await app.inject({
      method: "GET",
      url: "/items/7",
      headers: { "x-request-id": "trace-abc.123:def" },
    });
    expect(res.headers["x-request-id"]).toBe("trace-abc.123:def");
    expect(sink.records.every((r) => r["reqId"] === "trace-abc.123:def")).toBe(true);
  });

  it.each([
    ["too long", "a".repeat(129)],
    ["with spaces", "has space"],
    ["with markup", "<script>alert(1)</script>"],
    ["with a log-injection payload", 'x","level":"fatal","msg":"forged'],
  ])("replaces a malformed X-Request-Id (%s)", async (_label, value) => {
    const { app, sink } = await build();
    const res = await app.inject({
      method: "GET",
      url: "/items/7",
      headers: { "x-request-id": value },
    });
    expect(res.headers["x-request-id"]).toMatch(UUID);
    expect(sink.text).not.toContain(value);
  });

  it("sets X-Request-Id on 404 and 500 responses as well", async () => {
    const { app } = await build();
    const notFound = await app.inject({ method: "GET", url: "/missing" });
    const failed = await app.inject({ method: "GET", url: "/boom" });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.headers["x-request-id"]).toMatch(UUID);
    expect(failed.statusCode).toBe(500);
    expect(failed.headers["x-request-id"]).toMatch(UUID);
  });
});

describe("secrets in request logs", () => {
  it("never logs Authorization, Cookie, credentials in the URL or body passwords", async () => {
    const { app, sink } = await build();
    const res = await app.inject({
      method: "POST",
      url: `/login?code=${SECRET.oidcCode}&state=${SECRET.oidcState}&page=2`,
      headers: {
        authorization: `Bearer ${SECRET.apiToken}`,
        cookie: SECRET.sessionCookie,
        "x-api-key": SECRET.clientSecret,
        "x-request-id": "login-1",
      },
      payload: {
        username: "owner",
        password: SECRET.password,
        nested: { client_secret: SECRET.clientSecret },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(findLeaks(sink.text)).toEqual([]);

    const incoming = sink.records.find((r) => r["msg"] === "incoming request");
    const req = (incoming ?? {})["req"] as Record<string, unknown>;
    expect(req["method"]).toBe("POST");
    expect(String(req["url"])).toContain(`code=${REDACTED}&state=${REDACTED}&page=2`);
    const dump = sink.records.find((r) => r["msg"] === "debug dump");
    expect(dump?.["headers"]).toMatchObject({
      authorization: REDACTED,
      cookie: REDACTED,
      "x-api-key": REDACTED,
      "x-request-id": "login-1",
    });
    expect(dump?.["body"]).toMatchObject({ username: "owner", password: REDACTED });
  });

  it("scrubs secrets out of a logged handler error", async () => {
    const { app, sink } = await build();
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(sink.text).not.toContain(SECRET.opaqueBearer);
    expect(sink.text).not.toContain(SECRET.literal);
    const failure = sink.records.find((r) => r["level"] === "error");
    const err = (failure ?? {})["err"] as Record<string, unknown>;
    expect(String(err["message"])).toContain("upstream said");
  });
});

describe("actor binding", () => {
  it("puts the actor on every later line, including the request-completed line", async () => {
    const { app, sink } = await build();
    const res = await app.inject({ method: "GET", url: "/actor" });
    const id = res.headers["x-request-id"];
    const expected = {
      reqId: id,
      actor: "analytics-agent",
      actorType: "agent",
      tokenId: "tok-1",
      tokenName: "analytics-agent",
      ownerId: "user-1",
      ownerUsername: "owner",
    };
    const toolCall = sink.records.find((r) => r["msg"] === "tool call");
    const completed = sink.records.find((r) => r["msg"] === "request completed");
    expect(toolCall).toMatchObject(expected);
    expect(completed).toMatchObject({ ...expected, res: { statusCode: 200 } });
    // Lines written before authentication carry the request id but not the actor.
    const incoming = sink.records.find((r) => r["msg"] === "incoming request");
    expect(incoming).toMatchObject({ reqId: id });
    expect(incoming).not.toHaveProperty("actor");
  });

  it("replaces the actor when bound again instead of repeating keys", async () => {
    const { app, sink } = await build();
    await app.inject({ method: "GET", url: "/actor-twice" });
    const completedLine = sink.lines.find((line) => line.includes('"request completed"')) ?? "";
    expect(completedLine.match(/"actor":/g)).toHaveLength(1);
    expect(JSON.parse(completedLine)).toMatchObject({
      actor: "second",
      actorType: "human",
      userId: "u-1",
    });
    expect(completedLine).not.toContain('"first"');
  });
});
