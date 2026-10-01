import { z } from "zod";
import { LOG_LEVELS } from "./logger.js";

/** Thrown by {@link loadEnv}; the message lists every invalid variable and never a value. */
export class EnvError extends Error {
  override name = "EnvError";
}

/**
 * Variables both services read. Spread it into the app's own schema:
 * `z.object({ ...baseEnvShape({ port: 3001 }), DATABASE_URL: z.url() })`.
 * Each field carries a description, which {@link renderEnvTable} turns into documentation.
 */
export function baseEnvShape(defaults: { port: number }) {
  return {
    HOST: z.string().default("0.0.0.0").describe("Interface to listen on."),
    PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(defaults.port)
      .describe("Port to listen on."),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info").describe("Minimum level written to the log."),
    APP_VERSION: z
      .string()
      .default("0.0.0-dev")
      .describe("Release version shown on /healthz; container builds set it."),
    GIT_SHA: z
      .string()
      .default("unknown")
      .describe("Git commit shown on /healthz; container builds set it."),
    METRICS_TOKEN: z
      .string()
      .min(16)
      .optional()
      .describe(
        "When set, GET /metrics requires `Authorization: Bearer <token>`. Set it whenever /metrics is reachable beyond a private network: unset, the endpoint is open.",
      ),
  };
}

/**
 * Validates the environment and returns it parsed, or throws {@link EnvError} naming every bad
 * variable so one startup attempt shows all the problems. An empty value counts as unset, so
 * `FOO=` in a `.env` file falls back to the default. Values are never echoed in the message,
 * because several variables are secrets.
 */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Readonly<Record<string, string | undefined>> = process.env,
  options: { service?: string } = {},
): z.output<S> {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = schema.safeParse(present);
  if (result.success) return result.data;

  const problems = result.error.issues.map(
    (issue) => `  - ${issue.path.join(".") || "(environment)"}: ${issue.message}`,
  );
  const subject = options.service ? ` for ${options.service}` : "";
  throw new EnvError(`Invalid environment${subject}:\n${problems.join("\n")}`);
}

/** One row of the environment documentation. */
export interface EnvVariableDoc {
  name: string;
  /** No default and not optional: the process refuses to start without it. */
  required: boolean;
  /** The default as it would be written in a `.env` file, if there is one. */
  default?: string;
  /** Short human description of the accepted values. */
  type: string;
  description: string;
}

interface JsonSchemaProperty {
  type?: string;
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  description?: string;
}

function describeType(property: JsonSchemaProperty): string {
  if (property.enum) return `one of ${property.enum.map(String).join(", ")}`;
  if (property.format === "uri") return "URL";
  if (property.type === "integer" || property.type === "number") {
    const base = property.type === "integer" ? "integer" : "number";
    // zod's `.int()` adds the safe-integer range as bounds; those are not a constraint worth showing.
    const minimum = property.minimum === Number.MIN_SAFE_INTEGER ? undefined : property.minimum;
    const maximum = property.maximum === Number.MAX_SAFE_INTEGER ? undefined : property.maximum;
    if (minimum !== undefined && maximum !== undefined) return `${base} ${minimum} to ${maximum}`;
    if (minimum !== undefined) return `${base} >= ${minimum}`;
    if (maximum !== undefined) return `${base} <= ${maximum}`;
    return base;
  }
  if (property.type === "boolean") return "boolean";
  if (property.minLength === 1) return "non-empty string";
  if (property.minLength !== undefined) return `string, at least ${property.minLength} characters`;
  return "string";
}

/** Lists the variables of an environment schema, in declaration order. */
export function describeEnv(schema: z.ZodType): EnvVariableDoc[] {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as {
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, property]) => {
    const doc: EnvVariableDoc = {
      name,
      required: required.has(name),
      type: describeType(property),
      description: property.description ?? "",
    };
    if (property.default !== undefined) doc.default = String(property.default);
    return doc;
  });
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/**
 * Renders the environment schema as a markdown table (variable, required, default, type,
 * description) for the README and `docs/`, so the documentation cannot drift from the schema.
 */
export function renderEnvTable(schemaOrDocs: z.ZodType | readonly EnvVariableDoc[]): string {
  const docs = Array.isArray(schemaOrDocs)
    ? (schemaOrDocs as readonly EnvVariableDoc[])
    : describeEnv(schemaOrDocs as z.ZodType);
  const rows = docs.map((doc) =>
    [
      `\`${doc.name}\``,
      doc.required ? "yes" : "no",
      doc.default === undefined ? "" : `\`${cell(doc.default)}\``,
      cell(doc.type),
      cell(doc.description),
    ].join(" | "),
  );
  return [
    "| Variable | Required | Default | Values | Description |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}
