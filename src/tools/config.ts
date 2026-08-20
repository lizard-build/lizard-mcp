import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { withScope } from "../lib/api.js";
import { resolveProject } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

export function registerConfigTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "config.apply",
    {
      description:
        "Use this when the user wants to apply a bulk, config-as-code style configuration to a Lizard project in one request (multiple services/addons/secrets at once), rather than changing one field at a time.",
      inputSchema: {
        project: z.string().min(1),
        config: z
          .record(z.string(), z.unknown())
          .describe("Arbitrary config:apply request body — passed through verbatim, validated server-side"),
      },
    },
    handle(async ({ project, config }) => {
      const proj = await resolveProject(ctx.api, project);
      return ctx.api.post(withScope(`/api/projects/${proj.id}/config:apply`, { workspaceId: proj.workspaceId }), config);
    }),
  );
}
