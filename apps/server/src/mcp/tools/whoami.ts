import { principalLevels } from "@ytw/policy";
import { defineTool, type ToolRegistry } from "../registry.js";

/**
 * A whoami tool: returns token name, owner username, and effective levels.
 */
export const whoamiTool = defineTool({
  name: "whoami",
  description:
    "Returns the authenticated API token's name, owner username, and effective permission levels.",
  async handler(_input, context) {
    return {
      token: context.principal.tokenName,
      owner: context.principal.owner.username,
      effectiveLevels: principalLevels(context.principal),
    };
  },
});

export function register(registry: ToolRegistry): void {
  registry.register(whoamiTool);
}
