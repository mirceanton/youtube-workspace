/**
 * MCP write tools for scripts.
 */
import { saveScriptVersion, setScriptStatus } from "@ytw/db";
import { SCRIPT_BODY_MAX_BYTES, SCRIPT_KINDS, SCRIPT_STATUSES } from "@ytw/shared/constants";
import { z } from "zod";
import { defineTool, type ToolRegistry } from "../registry.js";

export const saveScriptVersionTool = defineTool({
  name: "save_script_version",
  description:
    "Appends a new draft revision to a script or packaging document. Fails with version conflict if base_version is not the current latest. Requires Write permission on scripts.",
  requires: { resource: "scripts", level: "write" },
  input: z.object({
    idea_id: z.string().uuid().describe("Idea UUID"),
    kind: z.enum(SCRIPT_KINDS).describe(`Document kind: ${SCRIPT_KINDS.join(", ")}`),
    base_version: z
      .number()
      .int()
      .min(0)
      .describe(
        "Base revision version: 0 if no version exists yet, or the current latest version number",
      ),
    body_md: z
      .string()
      .max(
        SCRIPT_BODY_MAX_BYTES,
        `Body exceeds maximum allowed size of ${SCRIPT_BODY_MAX_BYTES} bytes (1 MiB)`,
      )
      .describe("Script markdown content (up to 1 MiB)"),
  }),
  async handler(input, context) {
    return context.withTx((tx) =>
      saveScriptVersion(tx, {
        ideaId: input.idea_id,
        kind: input.kind,
        baseVersion: input.base_version,
        bodyMd: input.body_md,
      }),
    );
  },
});

export const setScriptStatusTool = defineTool({
  name: "set_script_status",
  description:
    "Updates the review status of a saved script revision. Requires Write permission on scripts.",
  requires: { resource: "scripts", level: "write" },
  input: z.object({
    script_id: z.string().uuid().describe("Script revision UUID"),
    status: z.enum(SCRIPT_STATUSES).describe(`Target status: ${SCRIPT_STATUSES.join(", ")}`),
  }),
  async handler(input, context) {
    return context.withTx((tx) =>
      setScriptStatus(tx, {
        scriptId: input.script_id,
        status: input.status,
      }),
    );
  },
});

export function register(registry: ToolRegistry): void {
  registry.register(saveScriptVersionTool);
  registry.register(setScriptStatusTool);
}
