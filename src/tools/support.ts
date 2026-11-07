import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { resolveProject } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

// Support tickets to the Lizard team (platform routes/support.ts). The tool names follow the
// support.md proposal: `support` opens a report, the rest read and answer it.
export function registerSupportTools(server: McpServer, ctx: ToolContext) {
  const clientName = () => {
    const info = server.server.getClientVersion();
    return info?.name ? `${info.name}${info.version ? ` ${info.version}` : ""}`.slice(0, 80) : undefined;
  };

  server.registerTool(
    "support",
    {
      title: "Open a support ticket",
      description:
        "Use this to tell the Lizard team that Lizard itself is broken, or that the user needs higher limits or a bigger plan. " +
        "Bug: open it without asking when a Lizard tool fails twice with a server error or timeout, or a sandbox/service is stuck or crashed with no cause in its own logs. " +
        "Limits/billing: ask the user first. Never for the user's own build errors or app bugs. " +
        "Never include secrets, keys, source code or customer data. The team answers in the ticket; replies are added to later tool results.",
      inputSchema: {
        summary: z.string().min(3).max(8000).describe("What you did and what went wrong, first line = title"),
        kind: z.enum(["bug", "limits", "billing", "question"]).optional().default("bug"),
        expected: z.string().max(4000).optional().describe("What should have happened"),
        actual: z.string().max(4000).optional().describe("What happened instead: the exact error text"),
        repro: z.string().max(4000).optional().describe("Shortest tool calls that show it"),
        error: z.string().max(2000).optional().describe("The failing tool, status and error, e.g. 'sandbox_create 500 internal error'"),
        sandboxId: z.string().max(100).optional().describe("The sandbox this is about; its state is attached"),
        service: z.string().max(100).optional().describe("The app (service id or name) this is about; its state is attached"),
        project: z.string().optional().describe("Project name/ID, to file it under that project's workspace"),
      },
      annotations: { title: "Open a support ticket", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ summary, kind, expected, actual, repro, error, sandboxId, service, project }) => {
      const workspaceId = project ? (await resolveProject(ctx.api, project)).workspaceId : undefined;
      return ctx.api.post("/api/support/tickets", {
        message: summary, type: kind, expected, actual, repro, source: "mcp", agent: clientName(),
        sandboxId, appId: service, workspaceId,
        context: error ? { lastErrors: [{ error, at: new Date().toISOString() }] } : {},
      });
    }),
  );

  server.registerTool(
    "support_list",
    {
      title: "List support tickets",
      description: "Use this to see the user's support tickets, their status and how many replies are unread.",
      inputSchema: {},
      annotations: { title: "List support tickets", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async () => (await ctx.api.get<{ tickets: unknown[] }>("/api/support/tickets")).tickets),
  );

  server.registerTool(
    "support_show",
    {
      title: "Show a support ticket",
      description: "Use this to read a support ticket's whole thread (marks the team's replies as read).",
      inputSchema: { ticket: z.string().min(1).describe("Ticket id, e.g. T-1043") },
      annotations: { title: "Show a support ticket", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ ticket }) => ctx.api.get(`/api/support/tickets/${encodeURIComponent(ticket)}`)),
  );

  server.registerTool(
    "support_reply",
    {
      title: "Reply on a support ticket",
      description: "Use this to answer a question from the Lizard team on a ticket, or add new details to it.",
      inputSchema: {
        ticket: z.string().min(1).describe("Ticket id, e.g. T-1043"),
        message: z.string().min(1).max(8000),
      },
      annotations: { title: "Reply on a support ticket", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ ticket, message }) => ctx.api.post(`/api/support/tickets/${encodeURIComponent(ticket)}/messages`, { message })),
  );
}
