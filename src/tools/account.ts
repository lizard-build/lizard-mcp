import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { withQuery, withScope } from "../lib/api.js";
import { handle } from "../lib/tool-helpers.js";
import { resolveProject } from "../lib/resolve.js";

export function registerAccountTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "workspace_create",
    {
      title: "Create workspace",
      description: "Create a new workspace when the user asks for one. Check workspace_list first. Each call creates another workspace; retries do not reuse the first one.",
      inputSchema: { name: z.string().min(1).max(80) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ name }) => ctx.api.post("/api/workspaces", { name })),
  );

  server.registerTool(
    "project_delete",
    {
      title: "Move project to trash",
      description: "Delete a project when its owner explicitly asks. Stops its services and moves the project to trash for three days. Requires the user's confirmation; do not call this to delete only one service.",
      inputSchema: {
        project: z.string().min(1).describe("Project name, slug, or ID; use an ID if names are ambiguous"),
        confirm: z.literal(true).describe("Set only after the user approves deleting this project"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project }) => {
      const target = await resolveProject(ctx.api, project);
      return ctx.api.delete(withScope(`/api/projects/${encodeURIComponent(target.id)}`, { workspaceId: target.workspaceId }));
    }),
  );

  for (const op of ["pause", "resume"] as const) {
    server.registerTool(
      `project_${op}`,
      {
        title: op === "pause" ? "Pause project" : "Resume project",
        description: op === "pause"
          ? "Use this when the user wants to stop every service of a Lizard project without deleting anything: each app and database scales to 0, keeping its URL, host, port, password, settings and volumes. Returns what was paused and what was skipped, with why. Undo with project_resume."
          : "Use this when the user wants to start again the services of a Lizard project that they paused. Services paused by a billing freeze stay paused until the account is paid. Returns what was resumed and what was skipped, with why.",
        inputSchema: { project: z.string().min(1).describe("Project name, slug, or ID") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      handle(async ({ project }) => {
        const target = await resolveProject(ctx.api, project);
        return ctx.api.post(withScope(`/api/projects/${encodeURIComponent(target.id)}/${op}`, { workspaceId: target.workspaceId }));
      }),
    );
    server.registerTool(
      `workspace_${op}`,
      {
        title: op === "pause" ? "Pause workspace" : "Resume workspace",
        description: op === "pause"
          ? "Use this when the workspace owner wants to stop every service in every project of a workspace without deleting anything (same as project_pause for each project). Owner only. Undo with workspace_resume."
          : "Use this when the workspace owner wants to start again everything they paused in a workspace. Owner only. Returns what was resumed and what was skipped, with why.",
        inputSchema: { workspaceId: z.string().min(1).describe("Workspace ID (see workspace_list)") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      handle(async ({ workspaceId }) => ctx.api.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/${op}`)),
    );
  }

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Use this when you need to identify the currently authenticated Lizard user, e.g. before asking which workspace or project to act on.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async () => ctx.api.get("/api/auth/me")),
  );

  server.registerTool(
    "workspace_list",
    {
      title: "List workspaces",
      description:
        "Use this when the user wants to see which Lizard workspaces they belong to, or needs a workspace ID to scope a project lookup.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async () => ctx.api.get("/api/workspaces")),
  );

  server.registerTool(
    "project_list",
    {
      title: "List projects",
      description: "Use this when the user wants to see their Lizard projects, optionally filtered to one workspace.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Filter to this workspace ID"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ workspaceId }) => ctx.api.get(withQuery("/api/projects", { workspaceId }))),
  );

  server.registerTool(
    "project_create",
    {
      title: "Create project",
      description:
        "Use this when the user wants to create a brand-new empty Lizard project to hold services. Calling this again creates another project, even with the same name — it does not update an existing one.",
      inputSchema: {
        name: z.string().min(1).describe("Project name"),
        workspaceId: z.string().min(1).describe("Workspace to create the project in"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ name, workspaceId }) => ctx.api.post("/api/projects", { name, workspaceId })),
  );

  server.registerTool(
    "region_list",
    {
      title: "List regions",
      description:
        "Use this when the user needs to know which deployment regions are available before creating a service or addon.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async () => ctx.api.get("/api/regions")),
  );
}
