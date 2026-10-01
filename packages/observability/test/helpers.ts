import Fastify, { type FastifyInstance } from "fastify";
import {
  createLogger,
  fastifyLoggingOptions,
  observabilityPlugin,
  type CreateLoggerOptions,
  type LogSink,
  type Logger,
  type ObservabilityOptions,
} from "../src/index.js";

/** In-memory log destination: keeps every emitted line exactly as it would reach stdout. */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  /** Everything emitted so far, as one string. Search this to prove a value never reached the log. */
  get text(): string {
    return this.lines.join("");
  }

  /** Every emitted line parsed as JSON; fails the test if a line is not valid JSON. */
  get records(): Array<Record<string, unknown>> {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  clear(): void {
    this.lines.length = 0;
  }
}

export function memoryLogger(overrides: Partial<CreateLoggerOptions> = {}): {
  logger: Logger;
  sink: MemorySink;
} {
  const sink = new MemorySink();
  const logger = createLogger({
    service: "mcp",
    level: "trace",
    version: "1.2.3",
    commit: "abc1234",
    destination: sink,
    ...overrides,
  });
  return { logger, sink };
}

/**
 * Distinctive secret-shaped values. Each contains a long unique fragment, so
 * `expect(output).not.toContain(fragment)` cannot pass by accident.
 */
export const SECRET = {
  apiToken: "ytw_Zq8vK2mXpL0aYb7dN3sQ9wRtUe5hJc1GfTiOk4VnM",
  jwt: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvd25lci0xMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVlLWhlcmU",
  sessionCookie: "ytw_sid=SESSIONVALUE-7f3a9c1e5b2d4f60",
  password: "hunter2-correct-horse-battery",
  clientSecret: "cs-live-8f7a6b5c4d3e2f1a0b9c",
  opaqueBearer: "opaque-credential-4d5e6f7a8b9c0d1e",
  dbPassword: "Tr0ub4dor-and-3-pg-pass",
  oidcCode: "authcode-1a2b3c4d5e6f7a8b",
  oidcState: "statevalue-9z8y7x6w5v4u",
  literal: "sessionsecret-literal-0123456789abcdef",
} as const;

/** Fragments of every {@link SECRET} value; none of them may ever appear in emitted output. */
const LEAK_FRAGMENTS: readonly string[] = [
  ...Object.values(SECRET),
  "Zq8vK2mXpL0aYb7dN3sQ9wRtUe5hJc1GfTiOk4VnM",
  "SESSIONVALUE-7f3a9c1e5b2d4f60",
];

/**
 * Which secrets appear in `text`. Assert `expect(findLeaks(output)).toEqual([])`: on failure the
 * message names the leaked values.
 */
export function findLeaks(text: string): string[] {
  return LEAK_FRAGMENTS.filter((fragment) => text.includes(fragment));
}

const openApps: FastifyInstance[] = [];

/** Registers an app to be closed by {@link closeApps}. */
export function trackApp(app: FastifyInstance): FastifyInstance {
  openApps.push(app);
  return app;
}

/** Closes every tracked app (including those from {@link buildObservedApp}); call from `afterEach`. */
export async function closeApps(): Promise<void> {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
}

/**
 * A Fastify app wired the way the services will wire it: shared logger, request ids, and the whole
 * observability plugin. `routes` adds the app's own routes before the app becomes ready.
 */
export async function buildObservedApp(
  overrides: Partial<ObservabilityOptions> = {},
  routes: (app: FastifyInstance) => void = () => {},
  loggerOverrides: Partial<CreateLoggerOptions> = {},
): Promise<{ app: FastifyInstance; sink: MemorySink }> {
  const { logger, sink } = memoryLogger(loggerOverrides);
  const app = trackApp(Fastify(fastifyLoggingOptions(logger)));
  await app.register(observabilityPlugin, {
    service: "mcp",
    version: "1.2.3",
    commit: "abc1234",
    defaultMetrics: false,
    ...overrides,
  });
  routes(app);
  await app.ready();
  return { app, sink };
}
