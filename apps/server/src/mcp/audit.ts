import type { Queryable } from "@ytw/db";

export interface ToolCallEvent {
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
 * Writes an immutable audit row for an MCP tool call (or the script file endpoint that does the
 * same job) through `ytw_log_event`, with action `tool.call` and actor type `agent`.
 */
export async function logToolCallEvent(db: Queryable, event: ToolCallEvent): Promise<void> {
  const payload: Record<string, unknown> = {
    tool: event.tool,
    outcome: event.outcome,
    token_owner: event.tokenOwner,
  };
  if (event.error !== undefined) {
    payload.error = event.error;
  }
  await db.query(
    `SELECT public.ytw_log_event(
       $1::text, 'agent'::text, $2::uuid, 'tool.call'::text, $3::text, $4::uuid, $5::jsonb)`,
    [
      event.actor,
      event.tokenId,
      event.entityType ?? null,
      event.entityId ?? null,
      JSON.stringify(payload),
    ],
  );
}
