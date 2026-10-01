import { hostname } from "node:os";
import type { Service } from "@ytw/shared/api/health";
import pino, { type Bindings, type ChildLoggerOptions, type Logger, type LogFn } from "pino";
import { createLineScrubber, createStringScrubber, redact } from "./redact.js";

export type { Logger } from "pino";

/** Accepted values of the `LOG_LEVEL` environment variable. */
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Anything a log line can be written to: stdout, a file, or an in-memory array in tests. */
export interface LogSink {
  write(line: string): unknown;
  flush?(callback?: (error?: Error | null) => void): void;
  flushSync?(): void;
}

export interface CreateLoggerOptions {
  /** Which process is logging; stamped on every line. */
  service: Service;
  /** Minimum level, default `info`. */
  level?: LogLevel;
  /** Release version and git commit (`APP_VERSION`, `GIT_SHA`), stamped on every line. */
  version?: string;
  commit?: string;
  /** Where lines go, default stdout. Every line is scrubbed before it reaches the sink. */
  destination?: LogSink;
  /**
   * Literal secret values (`SESSION_SECRET`, `OIDC_CLIENT_SECRET`, ...) that are removed from every
   * line wherever they appear. See {@link secretValuesFromEnv}.
   */
  secrets?: readonly string[];
  /** Extra fields on every line. */
  base?: Record<string, unknown>;
  /** Extra pino serializers; their output is redacted like everything else. */
  serializers?: Record<string, (value: unknown) => unknown>;
}

/** Environment variable names whose values are secrets. */
const SECRET_ENV_NAME = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|API_KEY|CREDENTIAL)/i;

/**
 * Collects the values of secret-looking environment variables (`SESSION_SECRET`,
 * `OIDC_CLIENT_SECRET`, `METRICS_TOKEN`, ...) for {@link CreateLoggerOptions.secrets}. Passwords
 * inside connection strings are removed by pattern and need no registration.
 */
export function secretValuesFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && SECRET_ENV_NAME.test(name)) values.push(value);
  }
  return values;
}

/**
 * Wraps a destination so that every serialized line is scrubbed on its way out. This is the last
 * line of defence: whatever the structured pass missed (a secret interpolated into a message, an
 * error stack, a serializer's output) is still caught here.
 */
function scrubbingSink(target: LogSink, scrub: (input: string) => string): LogSink {
  return {
    write: (line: string) => target.write(scrub(line)),
    flush: (callback) => {
      if (target.flush) target.flush(callback);
      else callback?.();
    },
    flushSync: () => target.flushSync?.(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RequestLike {
  method?: string;
  url?: string;
  host?: string;
  hostname?: string;
  ip?: string;
  socket?: { remoteAddress?: string; remotePort?: number };
}

/**
 * Request serializer for Fastify's "incoming request" / "request completed" lines. It picks fields
 * explicitly, so headers (Authorization, Cookie) can never be part of it; the URL is scrubbed
 * because OIDC callbacks carry `code` and `state` in the query string.
 */
function serializeRequest(request: unknown, scrub: (input: string) => string): unknown {
  if (!isRecord(request)) return request;
  const req = request as RequestLike;
  return {
    method: req.method,
    url: typeof req.url === "string" ? scrub(req.url) : undefined,
    host: req.host ?? req.hostname,
    remoteAddress: req.ip ?? req.socket?.remoteAddress,
    remotePort: req.socket?.remotePort,
  };
}

function serializeResponse(response: unknown): unknown {
  if (!isRecord(response)) return response;
  return { statusCode: response["statusCode"] };
}

/**
 * Creates the process logger: JSON lines with ISO timestamps and string levels, stamped with
 * `service`, `version` and `commit`, and with secrets removed (see `redact.ts`). Pass it to
 * Fastify as `loggerInstance` (see {@link fastifyLoggingOptions}) so request logs share it.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const scrub = createStringScrubber(options.secrets);
  const sink = scrubbingSink(
    options.destination ?? pino.destination(1),
    createLineScrubber(options.secrets),
  );

  const safe = (value: unknown): unknown => redact(value, scrub);

  // Every serializer's output is redacted, whatever the serializer returns.
  const serializers: Record<string, (value: unknown) => unknown> = {
    err: safe,
    req: (request) => safe(serializeRequest(request, scrub)),
    res: (response) => safe(serializeResponse(response)),
  };
  for (const [key, serializer] of Object.entries(options.serializers ?? {})) {
    serializers[key] = (value) => safe(serializer(value));
  }

  /**
   * Redacts the fields of a merge object or of child bindings. pino applies `formatters.log`
   * BEFORE the serializers, so fields that have a serializer (`req`, `res`, `err`) are left for it:
   * walking a live Fastify request here would flatten it and the serializer would see nothing.
   */
  const redactFields = (value: unknown): Record<string, unknown> => {
    if (!isRecord(value)) return { value: safe(value) };
    try {
      const own = Object.keys(value);
      const plain: Record<string, unknown> = {};
      const reserved: Record<string, unknown> = {};
      for (const key of own) {
        // Logging must never throw: a getter that does is logged as a marker.
        let field: unknown;
        try {
          field = value[key];
        } catch {
          field = "[Unserializable]";
        }
        if (Object.hasOwn(serializers, key)) reserved[key] = field;
        else plain[key] = field;
      }
      const redacted = safe(plain) as Record<string, unknown>;
      return Object.fromEntries(
        own.map((key) => [key, Object.hasOwn(reserved, key) ? reserved[key] : redacted[key]]),
      );
    } catch {
      return { logFields: "[Unserializable]" };
    }
  };

  const logger = pino(
    {
      level: options.level ?? "info",
      base: {
        service: options.service,
        version: options.version,
        commit: options.commit,
        pid: process.pid,
        hostname: hostname(),
        ...options.base,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers,
      formatters: {
        level: (label) => ({ level: label }),
        bindings: redactFields,
        log: redactFields,
      },
      hooks: {
        // Format arguments ("payload %j", obj) are interpolated into the message by pino, after the
        // merge object has been redacted, so they need the same treatment here.
        logMethod(args, method) {
          const cleaned = (args as unknown[]).map((arg, index) => {
            if (arg instanceof Error) return arg;
            if (typeof arg === "string") return scrub(arg);
            // The first argument may be the merge object; formatters.log redacts that one.
            if (index === 0) return arg;
            return typeof arg === "object" && arg !== null ? safe(arg) : arg;
          });
          method.apply(this, cleaned as Parameters<LogFn>);
        },
      },
    },
    sink,
  );

  // pino resets `formatters.bindings` on every child logger, so the formatter above only covers the
  // root bindings. Child bindings (Fastify's per-request `reqId`, our actor fields, anything a
  // caller adds) are redacted here instead. Children inherit this method through the prototype chain.
  type ChildFn = (this: unknown, bindings: Bindings, childOptions?: ChildLoggerOptions) => Logger;
  const child = logger.child as unknown as ChildFn;
  const redactingChild: ChildFn = function (this, bindings, childOptions) {
    return child.call(this, redactFields(bindings) as Bindings, childOptions);
  };
  logger.child = redactingChild as unknown as Logger["child"];

  return logger;
}
