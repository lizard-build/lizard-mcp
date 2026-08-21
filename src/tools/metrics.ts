import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { withQuery, withScope } from "../lib/api.js";
import { resolveProject, resolveService } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

export function registerMetricsTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "metrics_get",
    {
      title: "Get metrics",
      description: "Use this when the user wants CPU, memory, or network metrics for a Lizard app or addon over a time range.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1).optional().describe("Omit for project-level live metrics"),
        range: z.enum(["1h", "6h", "24h", "7d", "14d", "30d"]).optional().default("24h"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service, range }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };

      if (!service) {
        return ctx.api.get(withScope(withQuery(`/api/projects/${proj.id}/metrics`, { live: true }), scope));
      }

      const svc = await resolveService(ctx.api, proj.id, service, scope);
      if (svc.kind === "app") {
        // Matches lizard-cli's metrics.ts: the app-metrics endpoint specifically
        // is not workspace-scoped there either — don't add scope here.
        return ctx.api.get(withQuery(`/api/apps/${svc.id}/metrics`, { range }));
      }
      return ctx.api.get(withScope(withQuery(`/api/projects/${proj.id}/addons/${svc.id}/metrics`, { range }), scope));
    }),
  );

  server.registerTool(
    "billing_summary",
    {
      title: "Get billing summary",
      description: "Use this when the user wants a cost/billing summary for a Lizard workspace, including current usage and live spend.",
      inputSchema: { workspaceId: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ workspaceId }) => {
      const [summary, live] = await Promise.all([
        ctx.api.get(withQuery("/api/billing/summary", { workspaceId })),
        ctx.api.get(withQuery("/api/billing/live", { workspaceId })),
      ]);
      return { summary, live };
    }),
  );
}
