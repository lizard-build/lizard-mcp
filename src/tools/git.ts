import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { withScope } from "../lib/api.js";
import { resolveProject, resolveService } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

const PLATFORM_URL = process.env.PLATFORM_URL || "https://lizard.build";

interface GitHubStatus {
  installed: boolean;
  installationId: number | null;
  installations?: unknown[];
  manageUrl?: string;
  error?: string;
}

export function registerGitTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "git.checkout",
    {
      title: "Switch deploy branch",
      description:
        "Use this when the user wants to switch which branch a Lizard service deploys from, and redeploy it on that branch. Returns immediately once the redeploy is triggered.",
      inputSchema: { project: z.string().min(1), service: z.string().min(1), branch: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project, service, branch }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const svc = await resolveService(ctx.api, proj.id, service, scope);
      if (svc.kind !== "app") throw new Error(`"${service}" is not an app.`);

      await ctx.api.post(withScope(`/api/projects/${proj.id}/config:apply`, scope), {
        services: [{ name: svc.name, branch }],
      });
      const build = await ctx.api.post<{ id?: string }>(
        withScope(`/api/apps/${svc.id}/redeploy`, scope),
        undefined,
        { "X-Deploy-Source": "mcp" },
      );
      return { id: svc.id, buildId: build?.id, branch, status: "deploying" };
    }),
  );

  server.registerTool(
    "git.status",
    {
      title: "Get GitHub connection status",
      description: "Use this when the user wants to see GitHub connection status and the repo/branch each service in a Lizard project is tracking.",
      inputSchema: { project: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project }) => {
      const proj = await resolveProject(ctx.api, project);
      const [githubStatus, services] = await Promise.all([
        ctx.api.get<GitHubStatus>("/api/github/status"),
        ctx.api.get(withScope(`/api/projects/${proj.id}/services`, { workspaceId: proj.workspaceId })),
      ]);
      return { githubStatus, services };
    }),
  );

  server.registerTool(
    "git.connect",
    {
      title: "Get GitHub connect URL",
      description:
        "Use this when the user wants to connect their GitHub account to Lizard. Returns an install URL the user must open in a browser themselves — this cannot complete automatically.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async () => {
      const status = await ctx.api.get<GitHubStatus>("/api/github/status");
      if (status.installed) return { installed: true, installationId: status.installationId };
      return { installed: false, installUrl: `${PLATFORM_URL}/api/auth/github/install` };
    }),
  );
}
