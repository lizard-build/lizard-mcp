import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { withScope } from "../lib/api.js";
import { resolveProject } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";
import { redactServiceDetails } from "../lib/service-redaction.js";

export function registerConfigTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "config_apply",
    {
      title: "Apply bulk config",
      description:
        "Apply a configuration to a Lizard project in one request (services, addons and secrets). The config body is passed through verbatim and can overwrite or remove existing fields. Credentials in the response are masked; use service_reveal or secrets_reveal only when the user asks for them. Requires confirm:true after the user approves. Uses the Lizard API config:apply endpoint; docs: https://lizard.build/docs/.",
      inputSchema: {
        project: z.string().min(1),
        config: z
          .record(z.string(), z.unknown())
          .describe("Arbitrary config:apply request body — passed through verbatim, validated server-side"),
        confirm: z.literal(true).describe("Must be true to proceed; there is no interactive confirmation in MCP"),
      },
      // Passed through verbatim to a bulk endpoint capable of overwriting or
      // removing fields not listed, so treated as destructive/non-idempotent
      // even though most individual calls are benign merges.
      annotations: { title: "Apply bulk config", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project, config }) => {
      const proj = await resolveProject(ctx.api, project);
      return ctx.api.post(withScope(`/api/projects/${proj.id}/config:apply`, { workspaceId: proj.workspaceId }), config).then(redactServiceDetails);
    }),
  );
}

