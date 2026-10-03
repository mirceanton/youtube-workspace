/**
 * MCP query_sql tool (PRD 5, T33).
 *
 * Runs raw read-only SQL queries on the ytw_readonly role.
 * Only offered/registered for tokens with Read on every object (including activity log).
 */
import { ForbiddenError, queryReadOnly, ValidationError } from "@ytw/db";
import { hasReadOnEverything } from "@ytw/policy";
import { z } from "zod";
import { defineTool, type ToolRegistry } from "../tools.js";

export const SQL_ROW_CAP = 500;
export const SQL_OUTPUT_BYTE_CAP = 1_000_000; // 1 MB

/**
 * Checks whether SQL text contains at most a single statement, properly ignoring semicolons
 * inside string literals ('...'), dollar-quoted blocks ($$...$$ or $tag$...$tag$),
 * line comments (-- ...) and block comments (/* ... *\/).
 */
export function isSingleStatement(sql: string): boolean {
  let inSingleQuote = false;
  let inDollarQuote: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let foundSemicolon = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const nextChar = sql[i + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && nextChar === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inSingleQuote) {
      if (char === "'") {
        if (nextChar === "'") {
          // Escaped single quote ('')
          i++;
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }

    if (inDollarQuote !== null) {
      if (char === "$" && sql.slice(i).startsWith(inDollarQuote)) {
        i += inDollarQuote.length - 1;
        inDollarQuote = null;
      }
      continue;
    }

    // Outside comments and quotes
    if (char === "-" && nextChar === "-") {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      continue;
    }

    if (char === "$") {
      const match = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
      if (match) {
        inDollarQuote = match[0];
        i += match[0].length - 1;
        continue;
      }
    }

    if (char === ";") {
      foundSemicolon = true;
      continue;
    }

    if (foundSemicolon && char !== undefined) {
      // Any non-whitespace character after an unquoted semicolon indicates a subsequent statement
      if (!/\s/.test(char)) {
        return false;
      }
    }
  }

  return true;
}

export const querySqlTool = defineTool({
  name: "query_sql",
  description:
    "Executes a single read-only SQL query against the workspace database. Available only to tokens with Read permission on all resources. Enforces a 10s statement timeout and caps output at 500 rows.",
  filter: (principal) => hasReadOnEverything(principal),
  input: z.object({
    sql: z.string().min(1).describe("Single read-only SQL SELECT query"),
  }),
  async handler(input, context) {
    if (!hasReadOnEverything(context.principal)) {
      throw new ForbiddenError(
        "query_sql requires Read access on all resources, including the activity log",
        { reason: "all_read_required" },
      );
    }

    const trimmed = input.sql.trim();
    if (!isSingleStatement(trimmed)) {
      throw new ValidationError(
        "multi-statement queries are not allowed: execute one statement at a time",
        { field: "sql" },
      );
    }

    const pool = context.readonlyPool ?? context.pool;
    const res = await queryReadOnly<Record<string, unknown>>(pool, trimmed);

    const truncated = res.rows.length > SQL_ROW_CAP;
    const rows = truncated ? res.rows.slice(0, SQL_ROW_CAP) : res.rows;
    const json = JSON.stringify(rows);

    if (json.length > SQL_OUTPUT_BYTE_CAP) {
      throw new ValidationError(
        `query output exceeds maximum size limit of ${SQL_OUTPUT_BYTE_CAP} bytes: please narrow the query with LIMIT or select fewer columns`,
        { field: "sql", byteSize: json.length, maxBytes: SQL_OUTPUT_BYTE_CAP },
      );
    }

    return {
      columns: res.fields.map((f) => f.name),
      rowCount: rows.length,
      truncated,
      rows,
    };
  },
});

export function register(registry: ToolRegistry): void {
  registry.register(querySqlTool);
}
