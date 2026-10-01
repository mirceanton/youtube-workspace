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
const SECRET_ENV_NAME = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|API_KEY|CREDENTIAL|(^|_)KEY$)/i;
/** Names of connection strings, which carry a password inside the URL. */
const URL_ENV_NAME = /((^|_)(URL|URI|DSN)$|CONNECTION)/i;
/** `scheme://user:password@host`: the password is group 1. */
const URL_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]*:([^\s/?#@]+)@/i;
/** A bare password shorter than this is not registered: "postgres" would mangle every log line. */
const MIN_URL_PASSWORD_LENGTH = 12;

/**
 * Collects the secret values of the environment for {@link CreateLoggerOptions.secrets}: variables
 * named like a secret (`SESSION_SECRET`, `OIDC_CLIENT_SECRET`, `METRICS_TOKEN`, `*_API_KEY`,
 * `ENCRYPTION_KEY`, ...) and connection strings that carry a password (`DATABASE_URL`,
 * `MIGRATION_DATABASE_URL`, `READONLY_DATABASE_URL`), both whole and, when it is long enough to be a
 * real password, the password alone. Passwords inside any URL are also removed by pattern.
 */
export function secretValuesFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (SECRET_ENV_NAME.test(name)) {
      values.push(value);
    } else if (URL_ENV_NAME.test(name)) {
      const password = URL_PASSWORD.exec(value)?.[1];
      if (password === undefined) continue;
      values.push(value);
      if (password.length >= MIN_URL_PASSWORD_LENGTH) values.push(password, safeDecode(password));
    }
  }
  return values;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
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
 * explicitly, so headers (Authorization, Cookie) can never be part of it. The caller redacts the
 * result, which scrubs the URL (OIDC callbacks carry `code` and `state` in the query string).
 */
function serializeRequest(request: unknown): unknown {
  if (!isRecord(request)) return request;
  const req = request as RequestLike;
  return {
    method: req.method,
    url: req.url,
    host: req.host ?? req.hostname,
    remoteAddress: req.ip ?? req.socket?.remoteAddress,
    remotePort: req.socket?.remotePort,
  };
}

/** The error that pino would take the log message from, if the call has no message of its own. */
function errorBehind(first: unknown): Error | undefined {
  try {
    if (first instanceof Error) return first;
    if (isRecord(first) && first["msg"] === undefined && first["err"] instanceof Error) {
      return first["err"];
    }
  } catch {
    // A hostile getter: no message to protect.
  }
  return undefined;
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

  type Serializer = (value: unknown) => unknown;
  /** A serializer whose output is redacted, whatever it returns. */
  const redactedSerializer =
    (serializer: Serializer): Serializer =>
    (value) =>
      safe(serializer(value));

  const serializers: Record<string, Serializer> = {
    err: safe,
    req: redactedSerializer(serializeRequest),
    res: redactedSerializer(serializeResponse),
  };
  for (const [key, serializer] of Object.entries(options.serializers ?? {})) {
    serializers[key] = redactedSerializer(serializer);
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

  /**
   * Child loggers can bring their own serializers and formatters (Fastify route-level
   * `logSerializers`); those would replace ours for their keys, so they are wrapped like ours.
   */
  const guardChildOptions = (
    childOptions: ChildLoggerOptions | undefined,
  ): ChildLoggerOptions | undefined => {
    if (!childOptions) return childOptions;
    const guarded: ChildLoggerOptions = { ...childOptions };
    if (childOptions.serializers) {
      const wrapped: Record<string, Serializer> = {};
      for (const [key, serializer] of Object.entries(childOptions.serializers)) {
        wrapped[key] = redactedSerializer(serializer as Serializer);
      }
      guarded.serializers = wrapped as ChildLoggerOptions["serializers"];
    }
    if (childOptions.formatters) {
      const { log: ownLog, bindings: ownBindings, ...others } = childOptions.formatters;
      guarded.formatters = {
        ...others,
        log: (object) => redactFields(ownLog ? ownLog(object) : object),
        bindings: (bound) => redactFields(ownBindings ? ownBindings(bound) : bound) as Bindings,
      };
    }
    return guarded;
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
          // `log.error(err)` and `log.error({ err })` take the message from the error, and pino
          // copies it into `msg` as it is. Give it the scrubbed text instead.
          if (cleaned.length < 2) {
            const error = errorBehind(cleaned[0]);
            if (error) cleaned[1] = scrub(error.message);
          }
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
    return child.call(this, redactFields(bindings) as Bindings, guardChildOptions(childOptions));
  };
  logger.child = redactingChild as unknown as Logger["child"];

  return logger;
}
