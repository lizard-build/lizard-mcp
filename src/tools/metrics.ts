import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { billingPageUrl, withQuery, withScope } from "../lib/api.js";
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
    "billing_status",
    {
      title: "Get plan and billing status",
      description:
        "Use this when a tool fails with PAYMENT_REQUIRED, or the user asks about their plan, trial or bill. " +
        "Returns the account's plan (none, pro, payg = old prepaid credits until November 1, 2026, enterprise), " +
        "the Pro status (trialing, active, past_due, canceled), trial days and trial credits left, this month's " +
        "credits used of the included $19 and the overage, the next charge, a pending cancel, an unpaid invoice " +
        "link, and billingUrl. Pro is $19/month, taxes included, with $19 of credits each month. Starting Pro, " +
        "paying and cancelling happen in the browser at billingUrl; give the user the link. With workspaceId, " +
        "reads that workspace owner's plan.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Read the plan of this workspace's owner instead of your own"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ workspaceId }) => {
      const sub = await ctx.api.get<Record<string, unknown>>(withQuery("/api/billing/subscription", { workspaceId }));
      return {
        ...sub,
        billingUrl: billingPageUrl(),
        ...(sub.plan === "payg" ? { notice: "Prepaid credits end on November 1, 2026. Start Pro in Billing before then." } : {}),
      };
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
