import { describe, expect, it } from "vitest";
import {
  MAX_SCRUB_LENGTH,
  SCRUB_HEAD_LENGTH,
  SCRUB_TAIL_LENGTH,
  createLineScrubber,
  createStringScrubber,
  redact,
  scrubString,
} from "../src/index.js";
import { SECRET, findLeaks, memoryLogger } from "./helpers.js";

/**
 * Regression tests for algorithmic complexity. Request URLs, headers and bodies are attacker
 * controlled and end up in log lines, so every value pattern must be linear: a 16 KB input that
 * makes a regex backtrack quadratically stalls the event loop for hundreds of milliseconds, and a
 * handful of such requests stall the whole service (this happened with the first version of the JWT
 * and URL patterns). Each input below targets one pattern with the shape that hurts a naive regex.
 */
const SIZE = 16 * 1024;
/** Linear scrubbing of 16 KB takes about a millisecond; the quadratic bugs took 300 ms and more. */
const BUDGET_MS = 25;

function repeat(unit: string, bytes = SIZE): string {
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

const HOSTILE: Record<string, string> = {
  "JWT starts separated by a class character": "/" + repeat("eyJ-"),
  "JWT start followed by a long class run": "eyJ" + "a".repeat(SIZE),
  "JWT segments without the second dot": "eyJaaaa." + "b".repeat(SIZE),
  "JWT-looking segments joined by dots": repeat("eyJaaaa."),
  "scheme-looking run before ://": repeat("a.") + "://b",
  "scheme with a huge user and password":
    "a://" + "b".repeat(SIZE / 2) + ":" + "c".repeat(SIZE / 2),
  "many userinfo candidates": repeat("a://b:c"),
  "nested schemes": repeat("a://"),
  "only delimiters": repeat("?&#"),
  "repeated sensitive query parameters": repeat("&code="),
  "repeated sensitive query parameters with values": repeat("?token=x&"),
  "name followed by endless whitespace": "password" + " ".repeat(SIZE),
  "assignment chain": repeat("a="),
  "one very long name before =": "a".repeat(SIZE) + "=x",
  "unterminated double quote after =": repeat('password="'),
  "unterminated single quote after =": repeat("token='"),
  "JSON pair keys without values": repeat('"password":'),
  "JSON pair with unterminated value": repeat('"secret" : "'),
  "escaped JSON pair": repeat('\\"password\\":\\"'),
  "Bearer repeated": repeat("Bearer "),
  "Bearer then endless whitespace": "Bearer" + " ".repeat(SIZE),
  "Bearer then a very long token": "Bearer " + "a".repeat(SIZE),
  "authorization repeated": repeat("authorization:"),
  "authorization then endless whitespace": "authorization:" + " ".repeat(SIZE),
  "authorization scheme then endless whitespace": "authorization: basic" + " ".repeat(SIZE),
  "cookie repeated": repeat("cookie="),
  "set-cookie repeated": repeat("set-cookie"),
  "ytw_ repeated": repeat("ytw_"),
  "short ytw_ candidates": repeat("ytw_aaaaaaaaaaa "),
  "ytw_ identifiers": repeat("ytw_save_script_version "),
  "a long run of token characters": "a".repeat(SIZE),
  "a long run of dots and dashes": repeat(".-"),
  "a long run of escapes": repeat("\\"),
  "escaped quotes": repeat('\\"'),
  "quoted names without a colon": repeat('"a"'),
  "one long quoted name": '"' + "a".repeat(SIZE),
  "assignment with an escaped quote": repeat('token=\\"'),
  "JSON pair with an escaped value": repeat('"token":\\"'),
  "JSON pair nested twice": repeat('\\\\\\"password\\\\\\":\\\\\\"'),
  "backslashes before a pair": "\\".repeat(SIZE / 2) + '"password":"x"',
  "mixed realistic noise": repeat(
    "GET /x?a=1&b=2&password=pw&code=c#frag Bearer abc.def cookie: a=b eyJhbGci.eyJzdWIi.sig ",
  ),
};

/**
 * The best of a few runs, so a scheduling hiccup on a busy CI machine cannot fail the test; a
 * quadratic pattern is slow on every run.
 */
function timeIt(fn: () => unknown, runs = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/** Touches every pattern once, so regex compilation is not part of the measurement. */
const WARM_UP =
  "GET http://u:p@h/x?code=1&password=a#access_token=b Bearer abcdefghij authorization: basic dXNlcg== " +
  'cookie: a=b eyJabcde.fghij.klm ytw_Abcdefghijkl12 password="x" {"token": "y"} \\"secret\\": \\"z\\"';

describe("value patterns are linear", () => {
  const stringScrubber = createStringScrubber([SECRET.literal]);
  const lineScrubber = createLineScrubber([SECRET.literal]);

  scrubString(WARM_UP);
  stringScrubber(WARM_UP);
  lineScrubber(JSON.stringify({ msg: WARM_UP }));
  redact({ req: { url: WARM_UP } });

  for (const [name, input] of Object.entries(HOSTILE)) {
    it(`scrubString: ${name}`, () => {
      expect(input.length).toBeLessThanOrEqual(SIZE + 64);
      expect(timeIt(() => scrubString(input))).toBeLessThan(BUDGET_MS);
    });

    it(`createStringScrubber with literals: ${name}`, () => {
      expect(timeIt(() => stringScrubber(input))).toBeLessThan(BUDGET_MS);
    });

    it(`createLineScrubber on the JSON line: ${name}`, () => {
      // Two copies of the input in one line.
      const line = JSON.stringify({ level: "info", msg: input, url: input }) + "\n";
      expect(timeIt(() => lineScrubber(line))).toBeLessThan(BUDGET_MS * 2);
    });

    it(`redact of a request-shaped object: ${name}`, () => {
      // Three copies of the input in one object.
      const value = { req: { url: input, headers: { "x-custom": input } }, body: { note: input } };
      expect(timeIt(() => redact(value))).toBeLessThan(BUDGET_MS * 3);
    });
  }

  it("the line pass, which is never cut, stays linear on 256 KB lines", () => {
    // Quadratic behaviour at this size takes seconds; linear takes about 20 ms.
    const slow = Object.entries(HOSTILE)
      .filter(([, input]) => {
        const line = JSON.stringify({ msg: input.repeat(16) }) + "\n";
        return timeIt(() => lineScrubber(line), 1) >= 400;
      })
      .map(([name]) => name);
    expect(slow).toEqual([]);
  });

  it("a whole request logged through the real logger stays fast", () => {
    const { logger } = memoryLogger({ secrets: [SECRET.literal] });
    // Fastify's header limit is 16 KB, so a URL cannot be much larger than this.
    const url = "/" + repeat("eyJ-");
    logger.info({ req: { method: "GET", url } }, WARM_UP);
    const elapsed = timeIt(() => {
      logger.info({ req: { method: "GET", url } }, "incoming request");
      logger.info({ url }, `Route GET:${url} not found`);
      logger.error(new Error(`bad ${url}`));
    });
    expect(elapsed).toBeLessThan(BUDGET_MS * 4);
  });

  it("many hostile requests together do not add up to a stall", () => {
    const { logger } = memoryLogger();
    const inputs = Object.values(HOSTILE);
    const elapsed = timeIt(() => {
      for (let round = 0; round < 3; round++) {
        for (const input of inputs) logger.info({ req: { method: "GET", url: input } }, input);
      }
    }, 1);
    // About 100 hostile 16 KB inputs, each logged as a URL and as a message.
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("strings are bounded before they are scrubbed", () => {
  const scrub = createStringScrubber([SECRET.literal]);
  const token = SECRET.jwt;

  it("keeps strings up to the limit whole", () => {
    const text = "x".repeat(MAX_SCRUB_LENGTH);
    expect(scrub(text)).toBe(text);
  });

  it("cuts the middle out of an over-long string and says so", () => {
    const text = "head-" + "x ".repeat(MAX_SCRUB_LENGTH) + "-tail";
    const out = scrub(text);
    expect(out.length).toBeLessThan(MAX_SCRUB_LENGTH + 100);
    expect(out.startsWith("head-")).toBe(true);
    expect(out.endsWith("-tail")).toBe(true);
    expect(out).toMatch(/\[truncated \d+ characters\]/);
  });

  it("drops a secret that sits in the removed middle", () => {
    const filler = "a ".repeat(MAX_SCRUB_LENGTH / 2);
    const out = scrub(`${filler}Bearer ${SECRET.opaqueBearer} ${SECRET.apiToken} ${filler}`);
    expect(findLeaks(out)).toEqual([]);
  });

  it("removes literal secrets before cutting, so no fragment survives at either cut", () => {
    for (let offset = -40; offset <= 40; offset += 5) {
      const atHead =
        " ".repeat(SCRUB_HEAD_LENGTH + offset) + SECRET.literal + " ".repeat(MAX_SCRUB_LENGTH);
      const atTail =
        " ".repeat(MAX_SCRUB_LENGTH) + SECRET.literal + " ".repeat(SCRUB_TAIL_LENGTH + offset);
      for (const text of [atHead, atTail]) {
        const out = scrub(text);
        expect(out).not.toContain(SECRET.literal.slice(0, 10));
        expect(out).not.toContain(SECRET.literal.slice(-10));
      }
    }
  });

  it("does not leave half a token behind when the cut falls inside it", () => {
    for (let offset = -token.length - 10; offset <= 10; offset += 7) {
      const atHead = " ".repeat(SCRUB_HEAD_LENGTH + offset) + token + " ".repeat(MAX_SCRUB_LENGTH);
      const atTail = " ".repeat(MAX_SCRUB_LENGTH) + token + " ".repeat(SCRUB_TAIL_LENGTH + offset);
      for (const text of [atHead, atTail]) {
        const out = scrubString(text);
        expect(out).not.toContain(token.slice(0, 24));
        expect(out).not.toContain(token.slice(-24));
        expect(out).toContain("[truncated");
      }
    }
  });

  it("applies to every string in a logged object, not only to messages", () => {
    const { logger, sink } = memoryLogger();
    logger.info({ body: "z ".repeat(MAX_SCRUB_LENGTH) }, "m ".repeat(MAX_SCRUB_LENGTH));
    expect(sink.text.length).toBeLessThan(MAX_SCRUB_LENGTH * 3);
    expect(sink.records).toHaveLength(1);
    expect(sink.text.match(/\[truncated \d+ characters\]/g)).toHaveLength(2);
  });
});
