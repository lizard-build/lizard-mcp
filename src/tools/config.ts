import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { withScope } from "../lib/api.js";
import { resolveProject } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

export function registerConfigTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "config_apply",
    {
      title: "Apply bulk config",
      description:
        "Apply a configuration to a Lizard project in one request (services, addons and secrets). The config body is passed through verbatim and can overwrite or remove existing fields. Uses the Lizard API config:apply endpoint; docs: https://lizard.build/docs/.",
      inputSchema: {
        project: z.string().min(1),
        config: z
          .record(z.string(), z.unknown())
          .describe("Arbitrary config:apply request body — passed through verbatim, validated server-side"),
      },
      // Passed through verbatim to a bulk endpoint capable of overwriting or
      // removing fields not listed, so treated as destructive/non-idempotent
      // even though most individual calls are benign merges.
      annotations: { title: "Apply bulk config", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project, config }) => {
      const proj = await resolveProject(ctx.api, project);
      return ctx.api.post(withScope(`/api/projects/${proj.id}/config:apply`, { workspaceId: proj.workspaceId }), config);
    }),
  );
}
