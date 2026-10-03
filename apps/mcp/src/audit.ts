import type { Queryable } from "@ytw/db";

export interface LogToolCallEventOptions {
  actor: string;
  tokenId: string;
  tool: string;
  outcome: "ok" | "error" | "denied";
  error?: string;
  tokenOwner: string;
  entityType?: string | null;
  entityId?: string | null;
}

/**
 * Writes an immutable audit row for an MCP tool call (PRD 5, docs/database.md).
 * Uses public.ytw_log_event with action "tool.call" and actor type "agent".
 */
export async function logToolCallEvent(
  db: Queryable,
  options: LogToolCallEventOptions,
): Promise<string> {
  const payload: Record<string, unknown> = {
    tool: options.tool,
    outcome: options.outcome,
    token_owner: options.tokenOwner,
  };
  if (options.error !== undefined) {
    payload.error = options.error;
  }

  const result = await db.query<{ event_id: string }>(
    `SELECT public.ytw_log_event(
       $1::text,
       'agent'::text,
       $2::uuid,
       'tool.call'::text,
       $3::text,
       $4::uuid,
       $5::jsonb
     ) AS event_id`,
    [
      options.actor,
      options.tokenId,
      options.entityType ?? null,
      options.entityId ?? null,
      JSON.stringify(payload),
    ],
  );
  return result.rows[0]?.event_id ?? "";
}
