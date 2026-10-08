import pino, { type Logger } from "pino";
import { createLineScrubber } from "./redact.js";

export type { Logger } from "pino";

/** Accepted values of the `LOG_LEVEL` environment variable. */
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Anything a log line can be written to: stdout, or an in-memory array in tests. */
export interface LogSink {
  write(line: string): unknown;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  /** Release version and git commit, stamped on every line. */
  version?: string;
  commit?: string;
  /** Where lines go, default stdout. Every line is scrubbed before it reaches the sink. */
  destination?: LogSink;
  /** Literal secret values that are removed from every line wherever they appear. */
  secrets?: readonly string[];
}

/** Fields that are blanked by name when an object holding them is logged. */
const REDACT_PATHS = [
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "*.password",
  "*.secret",
  "*.token",
  "*.refresh_token",
  "*.id_token",
];

/**
 * JSON lines on stdout with secrets removed twice: by field name (pino `redact`) and by value over
 * the finished line (see redact.ts). The request serializer picks its fields explicitly, so request
 * headers never reach the log. Pass the result to Fastify as `loggerInstance`.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const scrub = createLineScrubber(options.secrets);
  const target = options.destination ?? pino.destination(1);
  return pino(
    {
      level: options.level ?? "info",
      base: { version: options.version, commit: options.commit },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      serializers: {
        err: pino.stdSerializers.err,
        req: (request: Record<string, unknown> & { socket?: { remotePort?: number } }) => ({
          method: request.method,
          url: request.url,
          host: request.host ?? request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        }),
        res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
      },
    },
    { write: (line: string) => target.write(scrub(line)) },
  );
}
