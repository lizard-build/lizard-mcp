import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { resolveProject, resolveService } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

/** Bare-attach (no hostname) generates a *.onlizard.com subdomain; a supplied
 *  hostname attaches a custom domain instead — same endpoint, two body
 *  shapes. Exported so unit tests can cover the dispatch directly. */
export function buildDomainAttachBody(
  hostname?: string,
  port?: number,
  force?: boolean,
): { hostname: string; port?: number; force?: boolean } | { generate: true } {
  return hostname ? { hostname, port, force } : { generate: true };
}

/** URL-encodes the hostname path segment for the delete endpoint. */
export function buildDomainDeletePath(appId: string, hostname: string): string {
  return `/api/apps/${appId}/domains/${encodeURIComponent(hostname)}`;
}

export function registerDomainTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "domain.attach",
    {
      description:
        "Use this when the user wants to attach a custom domain to a Lizard service, or generate a default *.onlizard.com subdomain if they don't have a custom one yet.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1),
        hostname: z.string().optional().describe("Custom hostname to attach; omit to generate a default subdomain"),
        port: z.number().int().optional(),
        force: z.boolean().optional().describe("Move the domain here if it's attached to another of your services"),
      },
    },
    handle(async ({ project, service, hostname, port, force }) => {
      const proj = await resolveProject(ctx.api, project);
      const svc = await resolveService(ctx.api, proj.id, service, { workspaceId: proj.workspaceId });
      return ctx.api.post(`/api/apps/${svc.id}/domains`, buildDomainAttachBody(hostname, port, force));
    }),
  );

  server.registerTool(
    "domain.verify",
    {
      description: "Use this when the user wants to verify DNS configuration for a custom domain attached to a Lizard service.",
      inputSchema: { project: z.string().min(1), service: z.string().min(1), hostname: z.string() },
    },
    handle(async ({ project, service, hostname }) => {
      const proj = await resolveProject(ctx.api, project);
      const svc = await resolveService(ctx.api, proj.id, service, { workspaceId: proj.workspaceId });
      return ctx.api.post(`/api/apps/${svc.id}/domains/verify`, { hostname });
    }),
  );

  server.registerTool(
    "domain.delete",
    {
      description:
        "Use this when the user wants to remove a custom domain from a Lizard service. This is destructive and requires explicit confirmation.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1),
        hostname: z.string(),
        confirm: z.literal(true).describe("Must be true to proceed; there is no interactive confirmation in MCP"),
      },
      annotations: { destructiveHint: true },
    },
    handle(async ({ project, service, hostname }) => {
      const proj = await resolveProject(ctx.api, project);
      const svc = await resolveService(ctx.api, proj.id, service, { workspaceId: proj.workspaceId });
      await ctx.api.delete(buildDomainDeletePath(svc.id, hostname));
      return { hostname, status: "deleted" };
    }),
  );
}
