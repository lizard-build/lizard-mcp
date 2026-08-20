import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { resolveProject, resolveService } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

export function registerDeployTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "deploy.redeploy",
    {
      description:
        "Use this when the user wants to trigger a new deployment of an existing Lizard service (rebuild and redeploy current source). Returns immediately once the build is triggered — use deploy.events to check progress.",
      inputSchema: { project: z.string().min(1), service: z.string().min(1) },
    },
    handle(async ({ project, service }) => {
      const proj = await resolveProject(ctx.api, project);
      const svc = await resolveService(ctx.api, proj.id, service, { workspaceId: proj.workspaceId });
      if (svc.kind !== "app") throw new Error(`"${service}" is an addon — redeploy only applies to apps.`);
      return ctx.api.post(`/api/apps/${svc.id}/redeploy`, undefined, { "X-Deploy-Source": "mcp" });
    }),
  );

  server.registerTool(
    "deploy.restart",
    {
      description:
        "Use this when the user wants to restart a running Lizard service without rebuilding it. Returns immediately.",
      inputSchema: { project: z.string().min(1), service: z.string().min(1) },
    },
    handle(async ({ project, service }) => {
      const proj = await resolveProject(ctx.api, project);
      const svc = await resolveService(ctx.api, proj.id, service, { workspaceId: proj.workspaceId });
      if (svc.kind !== "app") throw new Error(`"${service}" is an addon — restart only applies to apps.`);
      return ctx.api.post(`/api/apps/${svc.id}/restart`, undefined, { "X-Deploy-Source": "mcp" });
    }),
  );

  server.registerTool(
    "deploy.events",
    {
      description:
        "Use this when the user wants to see recent deploy/build history and current replica status for a Lizard service.",
      inputSchema: { project: z.string().min(1), service: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    handle(async ({ project, service }) => {
      const proj = await resolveProject(ctx.api, project);
      const svc = await resolveService(ctx.api, proj.id, service, { workspaceId: proj.workspaceId });
      if (svc.kind !== "app") throw new Error(`"${service}" is an addon — deploy events only apply to apps.`);
      const [deployEvents, podStatus] = await Promise.all([
        ctx.api.get(`/api/apps/${svc.id}/deploy-events`),
        // pod-status can fail independently (e.g. no pods scheduled yet, node
        // unreachable) — degrade to an empty list rather than failing the
        // whole call, matching lizard-cli's events.ts.
        ctx.api.get<{ pods?: unknown[] }>(`/api/apps/${svc.id}/pod-status`).catch(() => ({ pods: [] })),
      ]);
      return { deployEvents, podStatus };
    }),
  );
}
