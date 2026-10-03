/**
 * MCP tool for script file export (PRD 5, T34).
 */
import { getScriptVersion, NotFoundError } from "@ytw/db";
import { serializeScriptFile } from "@ytw/script-md";
import { SCRIPT_KINDS } from "@ytw/shared/constants";
import { z } from "zod";
import { defineTool, type ToolRegistry } from "../tools.js";

export const exportScriptTool = defineTool({
  name: "export_script",
  description:
    "Exports a script or packaging document as markdown with YAML front matter (idea_id, kind, version, status). Returns the latest version unless a specific version is requested. Requires Read permission on scripts.",
  requires: { resource: "scripts", level: "read" },
  input: z.object({
    idea_id: z.string().uuid().describe("Idea UUID"),
    kind: z.enum(SCRIPT_KINDS).describe("Script kind: script or packaging"),
    version: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Specific revision number to export (omitted means latest)"),
  }),
  async handler(input, context) {
    const script = await getScriptVersion(context.db, {
      ideaId: input.idea_id,
      kind: input.kind,
      version: input.version,
    });

    if (!script) {
      throw new NotFoundError(
        `script for idea "${input.idea_id}" and kind "${input.kind}"${input.version !== undefined ? ` version ${input.version}` : ""} does not exist`,
        { entity: "script", ideaId: input.idea_id, kind: input.kind, version: input.version },
      );
    }

    return serializeScriptFile({
      ideaId: script.ideaId,
      kind: script.kind,
      version: script.version,
      status: script.status,
      body: script.bodyMd,
    });
  },
});

export function register(registry: ToolRegistry): void {
  registry.register(exportScriptTool);
}
