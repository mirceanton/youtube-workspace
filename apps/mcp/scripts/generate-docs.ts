// oxlint-disable eslint/no-underscore-dangle, typescript/no-explicit-any
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createToolRegistry } from "../src/tools.js";

function unwrapZod(schema: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  isOptional: boolean;
  isNullable: boolean;
  description?: string;
} {
  let current = schema;
  let isOptional = false;
  let isNullable = false;
  let description = current.description;

  while (true) {
    if (current instanceof z.ZodOptional) {
      isOptional = true;
      description = description || current.description;
      current = current._def.innerType;
    } else if (current instanceof z.ZodNullable) {
      isNullable = true;
      description = description || current.description;
      current = current._def.innerType;
    } else if (current instanceof z.ZodDefault) {
      isOptional = true;
      description = description || current.description;
      current = current._def.innerType;
    } else {
      break;
    }
  }

  return { inner: current, isOptional, isNullable, description };
}

function formatZodType(type: z.ZodTypeAny): string {
  const { inner, isNullable } = unwrapZod(type);
  let base = "unknown";

  if (inner instanceof z.ZodString) {
    base = "string";
    const checks = (inner._def as any).checks || [];
    const minCheck = checks.find((c: any) => c.kind === "min");
    const maxCheck = checks.find((c: any) => c.kind === "max");
    const uuidCheck = checks.find((c: any) => c.kind === "uuid");
    if (uuidCheck) {
      base = "UUID";
    } else if (minCheck || maxCheck) {
      const parts: string[] = [];
      if (minCheck) parts.push(`min: ${minCheck.value}`);
      if (maxCheck) parts.push(`max: ${maxCheck.value}`);
      base = `string (${parts.join(", ")})`;
    }
  } else if (inner instanceof z.ZodNumber) {
    const isInt = (inner._def as any).checks?.some((c: any) => c.kind === "int");
    base = isInt ? "integer" : "number";
    const minCheck = (inner._def as any).checks?.find((c: any) => c.kind === "min");
    const maxCheck = (inner._def as any).checks?.find((c: any) => c.kind === "max");
    if (minCheck || maxCheck) {
      const parts: string[] = [];
      if (minCheck) parts.push(`min: ${minCheck.value}`);
      if (maxCheck) parts.push(`max: ${maxCheck.value}`);
      base = `${base} (${parts.join(", ")})`;
    }
  } else if (inner instanceof z.ZodBoolean) {
    base = "boolean";
  } else if (inner instanceof z.ZodEnum) {
    const values =
      (inner as any).options ??
      Object.keys((inner._def as any).entries ?? {}) ??
      (inner._def as any).values ??
      [];
    base = `enum (\`${values.join("`, `")}\`)`;
  } else if (inner instanceof z.ZodArray) {
    const itemType = (inner._def as any).element ?? (inner._def as any).type;
    base = `array of ${itemType ? formatZodType(itemType) : "unknown"}`;
  } else if (inner instanceof z.ZodUnion) {
    const options = (inner._def as any).options ?? (inner as any).options ?? [];
    base = (options as z.ZodTypeAny[]).map(formatZodType).join(" \\| ");
  } else if (inner instanceof z.ZodObject) {
    base = "object";
  } else if (inner instanceof z.ZodRecord) {
    base = "record";
  }

  return isNullable ? `${base} (nullable)` : base;
}

interface ParamDoc {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

function extractParams(input: unknown): ParamDoc[] {
  if (!input) {
    return [];
  }

  let shape: Record<string, z.ZodTypeAny> | undefined;
  if (input instanceof z.ZodObject) {
    shape = input.shape;
  } else if (typeof input === "object" && input !== null) {
    shape = input as Record<string, z.ZodTypeAny>;
  }

  if (!shape) {
    return [];
  }

  return Object.entries(shape).map(([name, schema]) => {
    const { isOptional, description } = unwrapZod(schema);
    return {
      name,
      type: formatZodType(schema),
      required: !isOptional,
      description: description ?? schema.description ?? "",
    };
  });
}

function getOutputDoc(toolName: string): string {
  switch (toolName) {
    case "whoami":
      return "`{ token: string, owner: string, effectiveLevels: Record<Resource, Level> }`";
    case "create_idea":
      return "`Idea` object containing `id`, `title`, `pitch`, `source`, `tags`, `score`, `status: 'inbox'`, `version: 1`, `created_at`, `updated_at`.";
    case "update_idea":
      return "`Idea` object with incremented `version` and updated non-status fields.";
    case "advance_idea":
      return "`Idea` object with new `status`, incremented `version`, and stage transition timestamp.";
    case "save_script_version":
      return "`ScriptVersion` object containing `id`, `ideaId`, `kind`, `version`, `status: 'draft'`, `bodyMd`, `createdAt`.";
    case "set_script_status":
      return "`ScriptVersion` object with updated `status` ('draft', 'review', or 'approved').";
    case "export_script":
      return "Markdown string with YAML front matter (`idea_id`, `kind`, `version`, `status`) followed by script body.";
    case "register_video":
      return "`Video` object containing `id`, `ideaId`, `youtubeId`, `title`, `publishedAt`, `createdAt`.";
    case "log_metrics":
      return "`VideoMetric` record with recorded snapshot metrics.";
    case "create_experiment":
      return "`Experiment` object with created `variants` (including assigned UUIDs and designated control).";
    case "record_variant_stats":
      return "`ExperimentVariant` record with updated impressions and CTR values.";
    case "conclude_experiment":
      return "`Experiment` object with `status: 'concluded'`, `winnerVariantId`, and `conclusion`.";
    case "add_note":
      return "`Note` object containing `id`, `entityType`, `entityId`, `bodyMd`, `author`, `createdAt`.";
    case "list_ideas":
      return "Array of pipeline ideas with `id`, `title`, `status`, `age_in_stage_days`, `latest_script_version`.";
    case "get_idea":
      return "`Idea` object with full details.";
    case "get_script":
      return "`ScriptVersion` object with full revision details and `bodyMd`.";
    case "list_videos":
      return "Array of videos with headline metrics (`views`, `ctr`, `avg_view_duration_s`) and channel median comparisons.";
    case "get_video_performance":
      return "Detailed performance record for the video including time-series metrics and deltas vs channel medians.";
    case "list_experiments":
      return "Array of experiments with current status and summary variant statistics.";
    case "get_experiment_results":
      return "Detailed experiment record with side-by-side variant comparisons, CTR differences vs control, and declared winner.";
    case "list_notes":
      return "Array of `Note` objects attached to the target entity, ordered chronologically.";
    case "search":
      return "Search results object with matches across readable ideas and scripts, ranked by relevance.";
    case "query_sql":
      return "`{ columns: string[], rowCount: number, truncated: boolean, rows: Record<string, unknown>[] }`";
    default:
      return "JSON result object.";
  }
}

function getErrorsDoc(toolName: string): string[] {
  const common = [
    "**401 Unauthorized**: Missing, expired, revoked, or unknown bearer API token.",
    "**403 Forbidden**: Token lacks the required permission level for this tool, or owner ceiling was lowered.",
  ];

  switch (toolName) {
    case "create_idea":
      return [
        ...common,
        "**Validation Error (400)**: Title is empty or exceeds 500 characters, or pitch/tags exceed size limits.",
      ];
    case "update_idea":
      return [
        ...common,
        "**Version Conflict (409)**: Provided `expected_version` does not match latest idea version in DB.",
        "**Not Found (404)**: Idea with specified UUID does not exist.",
      ];
    case "advance_idea":
      return [
        ...common,
        "**Invalid Transition (422)**: Target stage violates transition rules. Returns list of allowed next stages.",
        "**Validation Error (400)**: Stage transition backward without a required explanatory note.",
        "**Version Conflict (409)**: Provided `expected_version` does not match latest idea version.",
      ];
    case "save_script_version":
      return [
        ...common,
        "**Version Conflict (409)**: `base_version` is not the current latest. Response returns `latest_version`.",
        "**Validation Error (400)**: Markdown body exceeds 1 MiB limit.",
      ];
    case "set_script_status":
      return [
        ...common,
        "**Not Found (404)**: Script revision with specified UUID does not exist.",
        "**Validation Error (400)**: Invalid status value (must be 'draft', 'review', or 'approved').",
      ];
    case "export_script":
      return [
        ...common,
        "**Not Found (404)**: No script exists for the given idea ID and kind (or specific version).",
      ];
    case "register_video":
      return [
        ...common,
        "**Validation Error (400)**: Invalid `youtube_id` format or missing required title.",
        "**Duplicate (422)**: A video with this `youtube_id` is already registered.",
      ];
    case "log_metrics":
      return [
        ...common,
        "**Not Found (404)**: Target video does not exist.",
        "**Validation Error (400)**: Invalid timestamp or negative metric values.",
      ];
    case "create_experiment":
      return [
        ...common,
        "**Validation Error (400)**: Less than 2 variants, more than 10 variants, or not exactly one control designated.",
      ];
    case "record_variant_stats":
      return [
        ...common,
        "**Not Found (404)**: Experiment variant UUID does not exist.",
        "**Invalid Transition (422)**: Experiment is already concluded or cancelled.",
      ];
    case "conclude_experiment":
      return [
        ...common,
        "**Not Found (404)**: Experiment UUID does not exist.",
        "**Invalid Transition (422)**: Experiment is not in running status.",
      ];
    case "add_note":
      return [
        ...common,
        "**Validation Error (400)**: Blank note body or body exceeding 64 KiB.",
        "**Not Found (404)**: Target entity does not exist.",
      ];
    case "query_sql":
      return [
        ...common,
        "**Forbidden (403)**: Token does not possess Read access on ALL resources (including activity log).",
        "**Validation Error (400)**: Multi-statement query attempted (semicolons separating queries).",
        "**Validation Error (400)**: Result set payload exceeds 1 MB byte cap.",
        "**Database Error (422 / 500)**: SQL syntax error, mutation attempted (INSERT/UPDATE/DELETE blocked on read-only role), or statement timeout (10 seconds exceeded).",
      ];
    case "search":
      return [
        ...common,
        "**Forbidden (403)**: Token lacks Read permission on both ideas and scripts.",
      ];
    default:
      return common;
  }
}

export async function generateDocs(): Promise<string> {
  const registry = await createToolRegistry();
  const tools = registry.getTools();

  const writeTools = tools.filter((t) => t.requires?.level === "write");
  const readTools = tools.filter(
    (t) => t.requires?.level === "read" || t.name === "search" || t.name === "query_sql",
  );
  const sysTools = tools.filter((t) => !writeTools.includes(t) && !readTools.includes(t));

  const lines: string[] = [
    "# Model Context Protocol (MCP) Server Reference",
    "",
    "This document is the authoritative specification and user guide for the YouTube Workspace MCP service.",
    "It covers server architecture, transport protocols, stateless bearer authentication, agent integration configurations,",
    "token management, script export/import workflows, raw SQL execution constraints, and an exhaustive reference for every tool.",
    "",
    "> **Note:** This document is automatically generated by `pnpm docs:mcp` from the live tool definitions and Zod schemas in `apps/mcp/src/tools/`.",
    "",
    "---",
    "",
    "## 1. Architecture & Transport",
    "",
    "The MCP server is built using the official `@modelcontextprotocol/sdk` on top of **Fastify** with the **Streamable HTTP transport** (`StreamableHTTPClientTransport` / Fastify SSE/POST handler).",
    "",
    "### Key Invariants",
    "- **Stateless Bearer Authentication**: Every incoming HTTP request must include an `Authorization: Bearer <token-secret>` header. Tokens are SHA-256 hashed and verified directly against `ytw_private.api_tokens` in PostgreSQL on every request. Nothing is cached server-side: token revocations, expirations, rotations, and owner permission adjustments take effect on the very next call.",
    '- **Identical 401 Responses**: Missing, malformed, revoked, expired, and nonexistent tokens all return an identical `401 Unauthorized` JSON response (`{"error": "unauthorized", "message": "Unauthorized"}`) to eliminate token enumeration attacks.',
    "- **Brute-Force Rate Limiting**: Repeated authentication failures are tracked per IP and token prefix with a bounded sliding window (`FailureLimiter`), returning `429 Too Many Requests` with a `Retry-After` header when thresholds are exceeded.",
    "- **Immutable Audit Logging**: Every tool invocation writes an immutable audit record to `public.events` via `ytw_log_event()` with actor information (`actor = token.name`, `token_id = token.id`, `token_owner = owner.username`).",
    "- **Owner Ceiling RBAC**: A token can never perform an action beyond what its human owner currently possesses. Even if a token was granted `write`, if its owner is downgraded to `read` or `none`, the token's effective permission drops instantly.",
    "",
    "---",
    "",
    "## 2. Agent Integration Guide",
    "",
    "The MCP endpoint is exposed at:",
    "```text",
    "http://localhost:3001/mcp",
    "```",
    "",
    "### Claude Desktop Configuration",
    "Add the following to your `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):",
    "",
    "```json",
    "{",
    '  "mcpServers": {',
    '    "youtube-workspace": {',
    '      "command": "npx",',
    '      "args": [',
    '        "-y",',
    '        "@modelcontextprotocol/server-proxy",',
    '        "http://localhost:3001/mcp",',
    '        "--header",',
    '        "Authorization: Bearer YOUR_API_TOKEN_SECRET"',
    "      ]",
    "    }",
    "  }",
    "}",
    "```",
    "",
    "### Cursor Configuration",
    "In Cursor (`Settings -> Features -> MCP`):",
    "1. Click **+ Add New MCP Server**.",
    "2. Set **Name** to `youtube-workspace`.",
    "3. Set **Type** to `SSE` / `HTTP`.",
    "4. Set **URL** to `http://localhost:3001/mcp`.",
    "5. Under **Headers**, add:",
    "   - Key: `Authorization`",
    "   - Value: `Bearer YOUR_API_TOKEN_SECRET`",
    "",
    "### Generic MCP Client (Node.js SDK)",
    "```typescript",
    'import { Client } from "@modelcontextprotocol/sdk/client/index.js";',
    'import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";',
    "",
    "const transport = new StreamableHTTPClientTransport(",
    '  new URL("http://localhost:3001/mcp"),',
    "  {",
    "    requestInit: {",
    "      headers: {",
    '        Authorization: "Bearer ytw_YOUR_TOKEN_SECRET_HERE",',
    "      },",
    "    },",
    "  }",
    ");",
    "",
    'const client = new Client({ name: "my-agent", version: "1.0.0" }, { capabilities: {} });',
    "await client.connect(transport);",
    "",
    "// Discover available tools",
    "const { tools } = await client.listTools();",
    "console.log(tools.map((t) => t.name));",
    "```",
    "",
    "---",
    "",
    "## 3. Token Creation Steps",
    "",
    "API tokens are generated using the `ytw-admin` CLI or via the Settings screen in the Web UI.",
    "",
    "### Step 1: Bootstrap the Database Admin (if first run)",
    "```bash",
    'pnpm ytw-admin user create --username owner --email owner@channel.local --display-name "Channel Owner"',
    "```",
    "",
    "### Step 2: Grant Permissions to a Collaborator Account",
    "```bash",
    "pnpm ytw-admin user set-level --as owner bot-operator ideas=write scripts=write experiments=write videos=write notes=write activity=read",
    "```",
    "",
    "### Step 3: Issue an API Token for the Agent",
    "```bash",
    "pnpm ytw-admin token create \\",
    "  --owner bot-operator \\",
    '  --name "script-writer-agent" \\',
    "  --grant ideas=write,scripts=write,notes=write \\",
    "  --expires-in 90d",
    "```",
    "",
    "Output:",
    "```text",
    'Created API token "script-writer-agent" (0199a80b-f350-7000-8812-4e0078170000):',
    "  Owner:            bot-operator",
    "  Prefix:           ytw_K9j2L1mNx...",
    "  Expires At:       2026-07-02T12:00:00.000Z",
    "  Effective Levels: ideas=write scripts=write experiments=none videos=none notes=write activity=none",
    "",
    "Token Secret (show once):",
    "  ytw_K9j2L1mNxPqRsTuVwXyZ0123456789abc",
    "",
    "Store this secret securely now. It will never be displayed again.",
    "```",
    "",
    "---",
    "",
    "## 4. Script Markdown File Export & Import Recipe",
    "",
    "Agents that work directly with local markdown files on disk can round-trip script drafts seamlessly:",
    "",
    "### Step A: Export Script to Local Disk",
    "Call the `export_script` tool or make an HTTP GET request:",
    "```bash",
    'curl -H "Authorization: Bearer $TOKEN" \\',
    "  http://localhost:3001/files/scripts/{idea_id}/script > script.md",
    "```",
    "",
    "The exported file contains standard YAML front matter:",
    "```markdown",
    "---",
    "idea_id: 0199a80b-f350-7000-8812-4e0078170001",
    "kind: script",
    "version: 3",
    "status: draft",
    "---",
    "# Video Hook",
    "In this video we demonstrate...",
    "```",
    "",
    "### Step B: Edit the File Locally",
    "The agent makes edits to the body in its local workspace. Front matter preserves the `idea_id`, `kind`, and `version` (which serves as `base_version`).",
    "",
    "### Step C: Upload New Revision",
    "Call the `save_script_version` tool with `base_version: 3`, or perform an HTTP PUT:",
    "```bash",
    'curl -X PUT -H "Authorization: Bearer $TOKEN" \\',
    '  -H "Content-Type: text/markdown" \\',
    '  --data-binary "@script.md" \\',
    "  http://localhost:3001/files/scripts/{idea_id}/script?base_version=3",
    "```",
    "",
    "### Conflict Handling (Optimistic Concurrency)",
    "If another agent or human saved revision 4 while editing:",
    "- The request returns **HTTP 409 Conflict** with JSON:",
    "  ```json",
    '  { "error": "version_conflict", "message": "script was modified concurrently", "details": { "latest_version": 4 } }',
    "  ```",
    "- The agent inspects `details.latest_version`, re-downloads revision 4, reconciles differences, and re-submits with `base_version=4`.",
    "",
    "---",
    "",
    "## 5. `query_sql` Rules and Security Constraints",
    "",
    "`query_sql` provides agentic reasoning workflows with controlled SQL query capabilities subject to strict safety boundaries:",
    "",
    "1. **Read-Only Database Role**: Queries run strictly against `READONLY_DATABASE_URL` as user `ytw_readonly` with `default_transaction_read_only = on`. All `INSERT`, `UPDATE`, `DELETE`, and `ALTER` statements are rejected at the database engine level.",
    "2. **Strict Single-Statement Enforcement**: Queries are parsed to ensure only one SQL statement is present. Semicolon-delimited batches and multi-statement injection attempts are rejected before execution.",
    "3. **10-Second Statement Timeout**: A PostgreSQL `statement_timeout = 10000` is enforced per query. Long-running analytical scans are terminated automatically.",
    "4. **500-Row Hard Cap**: Queries returning more than 500 rows have their results truncated to 500 with `truncated: true` signaled in the response payload.",
    "5. **1 MB Output Size Cap**: JSON serialized output cannot exceed 1,000,000 bytes. Oversized queries are refused with a validation error instructing the caller to add a `LIMIT` clause or reduce columns.",
    "6. **Universal Read Access Prerequisite**: The calling token must possess `read` permission on **ALL** resources: `ideas`, `scripts`, `videos`, `experiments`, `notes`, and `activity`. If even a single resource is missing, the tool is withheld from registration and rejected.",
    "7. **Schema & Function Isolation**: Access to `ytw_private` (sessions, token hashes) and dangerous built-in functions (`pg_read_file`, `lo_import`, `SET ROLE`, `COPY PROGRAM`) is denied.",
    "",
    "---",
    "",
    "## 6. Complete Tool Reference",
    "",
  ];

  function renderToolSection(categoryTitle: string, toolList: typeof tools) {
    lines.push(`### ${categoryTitle}`, "");
    for (const tool of toolList) {
      lines.push(`#### \`${tool.name}\``, "");
      lines.push(tool.description, "");
      lines.push("");

      const perm =
        tool.name === "query_sql"
          ? "**Read** on ALL resources (`ideas`, `scripts`, `videos`, `experiments`, `notes`, `activity`)"
          : tool.name === "search"
            ? "**Read** on `ideas` or `scripts`"
            : tool.requires
              ? `**${tool.requires.level.toUpperCase()}** on \`${tool.requires.resource}\``
              : "Authenticated agent token";
      lines.push(`- **Required Permission**: ${perm}`);
      lines.push(`- **Output Format**: ${getOutputDoc(tool.name)}`);
      lines.push("");

      const params = extractParams(tool.input);
      if (params.length === 0) {
        lines.push("- **Parameters**: None (empty arguments `{}` accepted).", "");
      } else {
        lines.push("- **Parameters**:", "");
        lines.push("| Parameter | Type | Required | Description |");
        lines.push("| :--- | :--- | :--- | :--- |");
        for (const p of params) {
          lines.push(
            `| \`${p.name}\` | \`${p.type}\` | ${p.required ? "Yes" : "No"} | ${p.description || "-"} |`,
          );
        }
        lines.push("");
      }

      lines.push("- **Possible Errors**:");
      for (const err of getErrorsDoc(tool.name)) {
        lines.push(`  - ${err}`);
      }
      lines.push("");
    }
  }

  renderToolSection("Write Tools", writeTools);
  renderToolSection("Read Tools", readTools);
  renderToolSection("System & Identity Tools", sysTools);

  return lines.join("\n");
}

async function main(): Promise<void> {
  const content = await generateDocs();
  const targetPath = resolve(fileURLToPath(import.meta.url), "../../../../docs/mcp.md");
  await writeFile(targetPath, content, "utf8");
  console.log(`Successfully generated MCP documentation at: ${targetPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Failed to generate MCP docs:", err);
    process.exit(1);
  });
}
