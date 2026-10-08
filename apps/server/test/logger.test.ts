import { describe, expect, it } from "vitest";
import { createLogger } from "../src/observability/index.js";
import { generateToken } from "../src/tokens/index.js";

function capture(secrets: string[] = []) {
  const lines: string[] = [];
  const log = createLogger({
    level: "info",
    secrets,
    destination: { write: (l) => lines.push(l) },
  });
  return { log, output: () => lines.join("") };
}

describe("the logger", () => {
  it("removes configured secrets wherever they appear, in plain and JSON-escaped form", () => {
    const secret = 'session"secret-with-a-quote-and-length';
    const { log, output } = capture([secret]);
    log.info(`connecting with ${secret}`);
    log.info({ detail: { nested: `value ${secret}` } }, "fields");
    log.error(new Error(`failed: ${secret}`));
    expect(output()).not.toContain(secret);
    expect(output()).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(output()).toContain("[REDACTED]");
  });

  it("removes API tokens, bearer credentials, JWTs and URL passwords by their shape", () => {
    const { log, output } = capture();
    const token = generateToken().secret;
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl";
    log.info(`token ${token} header Bearer abcdefghijkl jwt ${jwt}`);
    log.info("postgres://app:hunter2-password@db:5432/app");
    log.info("GET /auth/callback?code=one-time-code&state=xyz&other=kept");
    log.info("cookie ytw_session=3f1c0b0e-0000-4000-8000-000000000000; Path=/");
    for (const leaked of [
      token,
      jwt,
      "abcdefghijkl",
      "hunter2-password",
      "one-time-code",
      "3f1c0b0e",
    ]) {
      expect(output()).not.toContain(leaked);
    }
    expect(output()).toContain("other=kept");
  });

  it("blanks credential fields by name and keeps names that only describe a token", () => {
    const { log, output } = capture();
    log.info({ headers: { authorization: "Bearer-less-secret", accept: "json" } }, "headers");
    log.info({ req: { headers: { cookie: "a=b" } } }, "request");
    log.info({ tokenName: "gateway", tool: "create_idea" }, "call");
    expect(output()).not.toContain("Bearer-less-secret");
    expect(output()).not.toContain("a=b");
    expect(output()).toContain("gateway");
    expect(output()).toContain("create_idea");
  });

  it("keeps database object names that start with ytw_", () => {
    const { log, output } = capture();
    log.info("select ytw_set_actor and ytw_log_event");
    expect(output()).toContain("ytw_set_actor and ytw_log_event");
  });
});
