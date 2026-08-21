import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { withQuery, withScope } from "../lib/api.js";
import { resolveProject, resolveService } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";
import { collectSSE } from "../lib/sse.js";

export function registerLogsTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "logs.tail",
    {
      title: "Tail logs",
      description:
        "Use this when the user wants to see recent log output from a Lizard service or a specific build. Returns a bounded snapshot, not a live stream.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1),
        limit: z.number().int().min(1).max(1000).optional().default(100),
        level: z.enum(["error", "warn", "info", "debug"]).optional().describe("Filter runtime logs by level"),
        build: z.boolean().optional().describe("Fetch build logs instead of runtime logs"),
        buildId: z.string().optional().describe("Specific build ID; defaults to the most recent build"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service, limit, level, build, buildId }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const svc = await resolveService(ctx.api, proj.id, service, scope);

      if (build) {
        let targetBuildId = buildId;
        if (!targetBuildId) {
          if (svc.kind !== "app") throw new Error("Build logs only apply to apps, not addons.");
          const app = await ctx.api.get<{ builds?: { id: string }[] }>(`/api/apps/${svc.id}`);
          if (!app.builds?.length) throw new Error("No builds for this app yet.");
          targetBuildId = app.builds[0].id;
        }
        const events = await collectSSE(`/api/builds/${targetBuildId}/logs`, ctx.accessToken, {
          idleTimeoutMs: 3000,
          stopOn: (event) => event === "done" || event === "error",
        });
        const chunks = events
          .filter((e) => e.event !== "done" && e.event !== "error")
          .map((e) => {
            try {
              const parsed = JSON.parse(e.data);
              return typeof parsed === "string" ? parsed : e.data;
            } catch {
              return e.data;
            }
          });
        const lines = chunks.join("").split("\n");
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        return { buildId: targetBuildId, lines: lines.slice(-limit) };
      }

      // Historical runtime logs are tagged by service *name*, not ID. An
      // empty name (addon with neither a name nor addonType) would silently
      // drop the filter and match every service instead of failing loudly.
      if (!svc.name) throw new Error(`Service "${service}" has no name to filter logs by.`);
      return ctx.api.get(
        withScope(withQuery(`/api/projects/${proj.id}/logs`, { limit, service: svc.name, level }), scope),
      );
    }),
  );
}
