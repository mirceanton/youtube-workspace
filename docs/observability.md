# Observability

`@ytw/observability` (`packages/observability`) is the one place where both services get their
logging, metrics, health probes and environment loading from (PRD 9, "Observability" and
"Security"). It depends on `fastify`, `pino`, `prom-client`, `zod` and `@ytw/shared`; it does not
depend on `@ytw/db`, so the database checks are injected by the app.

The apps do not use it yet: T30 (MCP server) and T40 (web server) wire it in with the recipe below.

## Wiring it into a service

```ts
import Fastify from "fastify";
import {
  baseEnvShape, createLogger, fastifyLoggingOptions, loadEnv, observabilityPlugin,
  secretValuesFromEnv,
} from "@ytw/observability";
import { z } from "zod";

const envSchema = z.object({
  ...baseEnvShape({ port: 3001 }), // HOST PORT LOG_LEVEL APP_VERSION GIT_SHA METRICS_TOKEN
  DATABASE_URL: z.url().describe("Connection string of the `ytw_mcp` role."),
});
const env = loadEnv(envSchema, process.env, { service: "mcp" }); // throws EnvError listing every problem

const logger = createLogger({
  service: "mcp",
  level: env.LOG_LEVEL,
  version: env.APP_VERSION,
  commit: env.GIT_SHA,
  secrets: secretValuesFromEnv(), // SESSION_SECRET, OIDC_CLIENT_SECRET, METRICS_TOKEN, ...
});

const app = Fastify({ ...fastifyLoggingOptions(logger), bodyLimit: 1024 * 1024 });
await app.register(observabilityPlugin, {
  service: "mcp",
  version: env.APP_VERSION,
  commit: env.GIT_SHA,
  metricsToken: env.METRICS_TOKEN,
  readiness: {
    database: async () => { await pool.query("select 1"); },
    migrations: async () => {
      const pending = await pendingMigrations(pool); // use what @ytw/db exposes for this
      return pending.length === 0 ? undefined : { ok: false, detail: `${pending.length} pending` };
    },
  },
});
```

`fastifyLoggingOptions` has to be a constructor option (Fastify reads the logger and the request-id
generator before any plugin runs). `observabilityPlugin` registers everything else.

### Integration gotchas

Things the T30 and T40 wiring has to handle; the package cannot do them for the app.

- **Drop the scaffold's own `/healthz` route.** `apps/web-server/src/app.ts` and `apps/mcp/src/app.ts`
  register one, and the plugin registers the same path, so Fastify fails at startup with a
  duplicate-route error. Replace the scaffold's `Fastify({ logger: { level } })` with
  `Fastify({ ...fastifyLoggingOptions(logger) })` and register `observabilityPlugin` before the
  app's own routes and plugins, so its hooks (request id, HTTP metrics) cover them.
- **Let the probes through authorization.** `/healthz` and `/readyz` carry no session and no bearer
  token (orchestrators and load balancers call them), and `/metrics` does its own check with
  `METRICS_TOKEN`. Add all three to the allowlist of the web server's session/CSRF guard and of the
  MCP server's bearer authentication, otherwise every probe is a 401 and the container is killed.
- **Fastify's default error handler echoes `err.message` to the client**, for 500s as well. A
  handler that fails with `new Error("token rejected: ytw_...")` sends that text to the caller (the
  log line is scrubbed; the HTTP response is not). Every service needs its own `setErrorHandler`:
  log the error with `request.log.error({ err })`, and for status 500 and above reply with a fixed
  message (plus the request id, so the caller can quote it), sending `err.message` only for errors
  that are meant for the client (validation failures, typed domain errors). The package does not
  ship one because what is safe to say depends on the service; T30 and T40 implement it.
- **Call `bindActor(request, reply, actor)` right after authentication**, in the same hook, so the
  request-completed line carries the actor even when the handler fails.

## Logging

`createLogger` returns a pino logger that writes one JSON object per line to stdout:

```json
{"level":"info","time":"2026-10-01T12:00:00.000Z","service":"mcp","version":"1.2.3","commit":"abc1234",
 "pid":1,"hostname":"mcp-7d9","reqId":"3f6c...","actor":"analytics-agent","actorType":"agent",
 "tokenId":"0b1c...","tokenName":"analytics-agent","res":{"statusCode":200},"responseTime":4.2,
 "msg":"request completed"}
```

- Level names are strings (`LOG_LEVEL`: `fatal error warn info debug trace silent`).
- `reqId` is on every request-scoped line. A well-formed incoming `X-Request-Id` (1 to 128 characters
  of letters, digits, `.` `_` `:` `-`) is reused so a request can be followed across services;
  anything else is replaced by a UUID, because the header is attacker-controlled. The id is returned
  as `X-Request-Id` on every response, including 404 and 500.
- `bindActor(request, reply, actor)` stamps the authenticated actor on every later line of the
  request, including Fastify's own "request completed" line. The fields mirror the `events` table
  (PRD 4): `actor` (username or token name), `actorType` (`human` or `agent`), and for agents
  `tokenId`, `tokenName`, `ownerId`, `ownerUsername`; for humans `userId`. Call it as soon as
  authentication succeeds; calling it again replaces the fields. Outside Fastify use
  `withActor(logger, actor)`.
- Probe and scrape routes (`/healthz`, `/readyz`, `/metrics`) log at `warn`, so they do not flood the
  request log; failures still appear.
- Pretty printing is deliberately not built in. For local reading pipe the output through
  `pino-pretty` (`pnpm dev | npx pino-pretty`).

### Redaction

The rule from PRD 5 and 9: tokens, cookies, secrets and `Authorization` headers never reach a log
line. Two independent layers enforce it, and both fail closed (when in doubt, the value is replaced
by `[REDACTED]`):

1. **By key.** Before a line is built, the merge object, the child-logger bindings, format
   arguments and every serializer's output are walked to any depth (objects, arrays, Maps, Headers,
   errors with their `cause` and attached properties). The value of every sensitive key is replaced.
   Keys are compared case-insensitively and ignoring `-` and `_`: `authorization`, `cookie`,
   `set-cookie`, anything containing `password`, `passwd`, `secret`, `credential`, `apikey`,
   `privatekey`, `encryptionkey`, `signingkey`, `hmackey`, `csrf`, `jwt`, `bearer`, `sessionid`,
   and anything containing `token` unless it only describes a token (`tokenId`, `tokenName`,
   `tokenPrefix`, `tokenOwnerUsername`, ... stay, so the audit trail remains readable). Log
   `tokenName`, never `token`. Inside a parameter container the names `code`, `state`, `nonce`,
   `key`, `sig` and `session` also count (an OIDC callback's query is `{ code, state }`). A parameter
   container is an object under a key that is `query`, `form`, `qs` or contains `query`, `param`,
   `callback`, `oauth`, `oidc` or `redirect`, everything below such a key, and any
   `URLSearchParams`; elsewhere `code` and `state` are ordinary fields (`err.code`, `idea.state`).
   A flat list of strings with an even length is read as name/value pairs (Node's `rawHeaders`, or
   `Headers` entries), and the value after a sensitive name is replaced, under any key or as a
   format argument.
2. **By value.** Every string (messages, format arguments, error text) and then the finished JSON
   line are scrubbed before anything reaches stdout, which catches a secret that was interpolated
   into a message or an error stack: `Bearer ...` credentials, `ytw_` API tokens, JWTs,
   `Cookie:`/`Authorization:` header text, passwords in connection strings
   (`postgres://user:password@host`), credential query parameters (`code`, `state`, `access_token`,
   `id_token`, `refresh_token`, `client_secret`, ...; Fastify logs request URLs, and OIDC callbacks
   carry `code` and `state`), assignments such as `password=...` and JSON dumped into a message
   (`{"refreshToken": "..."}`, also when that JSON is itself inside a JSON string, at any nesting
   depth), where the name is judged by the same rule as object keys in any naming style (`refresh_token`,
   `refreshToken`, `clientSecret`, `encryptionKey`; `max_tokens` and `tokenizer` are not credentials),
   and the literal values passed as `secrets` (see `secretValuesFromEnv`; values shorter than 8
   characters are ignored). The last pass over the line (`createLineScrubber`) never changes the
   structure of the JSON, and the message pino derives from an error (`log.error(err)`) is scrubbed
   like any other.

Log arguments, request URLs and bodies are attacker controlled, so the value layer is built to be
cheap on hostile input: every pattern is linear (a pattern that starts on a run of characters
excludes that run's own characters in a lookbehind, with no nested quantifiers), and any single
string longer than 16 KB (`MAX_SCRUB_LENGTH`) is cut to its first 12 KB and last 4 KB with
`[truncated N characters]` in between, without leaving half of a token at the cut. Do not log request
bodies wholesale; log identifiers. `test/scrub-performance.test.ts` holds a hostile 16 KB input for
every pattern; a new pattern needs one there.

Request lines use a serializer that picks `method`, `url`, `host` and the remote address explicitly,
so headers are never part of them. Serializers passed to a child logger (Fastify route-level
`logSerializers`) and the formatters of a child are wrapped, so their output is redacted too.
Binary data is logged as `[Binary N bytes]`; cycles as `[Circular]`; nesting beyond 12 levels as
`[Truncated]`.

Limits to know about: redaction cannot recognise a secret that has no sensitive key, no known shape
and is not registered (an opaque 20-character string in a field called `note`). The same helpers are
exported for other uses: `redact(value)` returns a safe copy, `scrubString(text)` cleans one string,
`isSensitiveKey(name)` is the key rule.

To extend the rules, edit `packages/observability/src/redact.ts` (`SENSITIVE_FRAGMENTS`,
`SENSITIVE_QUERY_PARAMS` or the value patterns) and add a case to `test/redact.test.ts`.

## Metrics

`GET /metrics` returns the Prometheus text format from a per-app registry (not prom-client's global
one). With `METRICS_TOKEN` set the endpoint requires `Authorization: Bearer <token>` (compared in
constant time). **`METRICS_TOKEN` must be set whenever `/metrics` is reachable from outside a
private network**: without it the endpoint is open to anyone, and the tool-call metrics contain API
token names (not the tokens). Scrape with `authorization: Bearer <token>` in the Prometheus job's
`authorization` block.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status` | Request rate; the `status` label gives the error rate |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status` | Latency |
| `mcp_tool_calls_total` | counter | `tool`, `token` | MCP tool calls by tool and API token name |
| `mcp_tool_call_failures_total` | counter | `tool`, `outcome` (`error`, `denied`) | Failed and permission-denied tool calls |
| `mcp_tool_call_duration_seconds` | histogram | `tool` | Tool handler duration, if recorded |
| `observability_label_overflow_total` | counter | `metric`, `label` | Label values folded into `__other__` |
| `ytw_build_info` | gauge | `service`, `version`, `commit` | Constant 1 |
| `process_*`, `nodejs_*` | various | | prom-client default Node.js metrics (can be disabled) |

- `route` is the matched route pattern (`/api/ideas/:id`), never the URL. Requests that match no route
  (404s, scanners) share the single value `unmatched`.
- Tool and token labels pass through a cardinality guard: the first 200 tools and 100 token names are
  kept, later new values collapse into `__other__` (and are counted), and values are trimmed to 64
  characters with control characters removed. Both limits can be changed with the `toolCalls`
  option. A client therefore cannot grow the registry by inventing names.
- T30 records every tool call (success, failure and denied) with
  `app.observability.toolCalls.record({ tool, token: tokenName, outcome, durationSeconds })`.
- Useful queries: `sum(rate(http_requests_total[5m])) by (route)`,
  `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`,
  `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))`,
  `sum(increase(mcp_tool_calls_total[1h])) by (tool, token)`.
- For tests, `metricValue(registry, name, labels)` reads one sample.

## Health and readiness

- `GET /healthz`: liveness. Always 200 while the process runs, body `{ status: "ok", service,
  version, commit }` (the `HealthResponse` contract in `@ytw/shared/api/health`).
- `GET /readyz`: readiness. Runs the injected checks in parallel: `200 {"status":"ready", ...}` when
  all pass, `503 {"status":"unavailable", ...}` when any fails. The body names each check and
  whether it passed. A check either resolves (healthy), throws (failed) or returns
  `{ ok: false, detail }`. The caller never sees an exception message, because it can name hosts and
  users: a thrown error shows as `check failed` and the full error goes to the log at `warn`. A
  check that exceeds `readinessTimeoutMs` (default 2000) fails with `timed out after N ms`.
  Because `/readyz` is unauthenticated, results are cached for `readinessCacheMs` (default 1000) and
  concurrent requests share one run, so probes cannot be turned into a flood of database queries.

The service wiring decides what "ready" means. The recipe above uses the two checks the plan asks
for: a database ping and "migrations current".

## Environment

`loadEnv(schema, source = process.env, { service })` validates the environment with zod and throws
`EnvError` listing every invalid variable (`  - PORT: Invalid input: expected number, received
NaN`). An empty value counts as unset. Values are never echoed in the message, because several
variables are secrets.

`baseEnvShape({ port })` gives both services the shared variables:

| Variable | Required | Default | Values | Description |
| --- | --- | --- | --- | --- |
| `HOST` | no | `0.0.0.0` | string | Interface to listen on. |
| `PORT` | no | `3000` | integer 1 to 65535 | Port to listen on. |
| `LOG_LEVEL` | no | `info` | one of fatal, error, warn, info, debug, trace, silent | Minimum level written to the log. |
| `APP_VERSION` | no | `0.0.0-dev` | string | Release version shown on /healthz; container builds set it. |
| `GIT_SHA` | no | `unknown` | string | Git commit shown on /healthz; container builds set it. |
| `METRICS_TOKEN` | no |  | string, at least 16 characters | When set, GET /metrics requires `Authorization: Bearer <token>`. Set it whenever /metrics is reachable beyond a private network: unset, the endpoint is open. |

The table above is generated by the package and a test checks that it is current. The default
`PORT` is a parameter: the web server uses 3000 and the MCP server 3001.

To document a whole service schema (T62 does this for the README), render it:
`renderEnvTable(envSchema)` returns the markdown table, `describeEnv(envSchema)` returns the rows as
data. Put a description on each field with `.describe("...")`; fields without a default and not
optional show as required.

## Tests

`pnpm --filter @ytw/observability test` runs the package's tests. The redaction tests emit real log
lines into an in-memory destination (`createLogger({ destination })`) and assert that no secret
value appears anywhere in the emitted text, for headers, nested objects and arrays, child
bindings, messages, format arguments, errors with causes, request URLs and a real HTTP round trip
over a socket. Services can reuse the pattern: pass a `destination` object with a `write(line)`
method to `createLogger` in their own tests.

## Deviations and notes

- The npm registry marks `prom-client` as deprecated in favour of `@prometheus-io/client` (same
  API, first released in August 2026). The plan names `prom-client` and it is the reference
  project's choice, so this package uses it. Every import of it is in `src/metrics.ts` and
  `src/metrics-route.ts`, so switching is a two-file change plus the dependency.
- Pino's built-in `redact` option is not used: it supports fixed paths and one wildcard level only,
  which cannot cover "any depth". The key and value layers above replace it.
