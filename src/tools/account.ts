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
      annotations: { title: "Create workspace", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ name }) => ctx.api.post("/api/workspaces", { name })),
  );

  server.registerTool(
    "project_delete",
    {
      title: "Move project to trash",
      description: "Delete a project when its owner explicitly asks. Its services and databases stop and stay in trash for 3 days; its sandboxes, their volumes and snapshots are deleted at once and cannot be recovered. Tell the user both parts before asking. Requires the user's confirmation; do not call this to delete only one service.",
      inputSchema: {
        project: z.string().min(1).describe("Project name, slug, or ID; use an ID if names are ambiguous"),
        confirm: z.literal(true).describe("Set only after the user approves deleting this project"),
      },
      annotations: { title: "Move project to trash", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
        annotations: { title: op === "pause" ? "Pause project" : "Resume project", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
        annotations: { title: op === "pause" ? "Pause workspace" : "Resume workspace", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      handle(async ({ workspaceId }) => ctx.api.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/${op}`)),
    );
  }

  server.registerTool(
    "workspace_delete",
    {
      title: "Delete workspace",
      description: "Delete an empty workspace (owner only; not the personal one). The platform refuses while it still has live projects, sandboxes or volumes and says what is left. Requires the user's confirmation.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace ID (see workspace_list)"),
        confirm: z.literal(true).describe("Set only after the user approves deleting this workspace"),
      },
      annotations: { title: "Delete workspace", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ workspaceId }) => {
      await ctx.api.delete(withQuery(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { requireEmpty: true }));
      return { id: workspaceId, status: "deleted" };
    }),
  );

  server.registerTool(
    "workspace_limits_get",
    {
      title: "Read workspace limits",
      description:
        "Use this when the user asks what a workspace may run at once, or a call failed with WORKSPACE_SANDBOX_LIMIT or WORKSPACE_USAGE_LIMIT. " +
        "Returns limits (maxRunningSandboxes, maxCpuVcpus, maxMemoryMb, maxDiskGb; null = no limit) and usage now (runningSandboxes, cpuVcpus, memoryMb, diskGb). " +
        "CPU and memory are what the workspace's apps and databases use, measured every ~10 s; disk is what its databases and volumes hold.",
      inputSchema: { workspaceId: z.string().min(1).describe("Workspace ID (see workspace_list)") },
      annotations: { title: "Read workspace limits", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ workspaceId }) => ctx.api.get(`/api/workspaces/${encodeURIComponent(workspaceId)}/limits`)),
  );

  server.registerTool(
    "workspace_limits_set",
    {
      title: "Set workspace limits",
      description:
        "Cap what a workspace may run at once (owner only, with a key that has no scopes). A field left out stays as it is; null removes that limit. " +
        "Past maxRunningSandboxes a sandbox create, fork or resume fails with WORKSPACE_SANDBOX_LIMIT. While CPU, memory or disk use is at a cap, deploys, restarts, scale-ups, new databases and volume growth fail with WORKSPACE_USAGE_LIMIT; running services keep running and data stays.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace ID (see workspace_list)"),
        maxRunningSandboxes: z.number().int().min(0).nullable().optional(),
        maxCpuVcpus: z.number().min(0).nullable().optional().describe("vCPU its apps and databases may be using"),
        maxMemoryMb: z.number().int().min(0).nullable().optional().describe("MB its apps and databases may be using"),
        maxDiskGb: z.number().min(0).nullable().optional().describe("GB its databases and volumes may hold"),
      },
      annotations: { title: "Set workspace limits", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ workspaceId, ...limits }) => {
      const body = Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) throw new Error("Pass at least one limit; workspace_limits_get reads them.");
      return ctx.api.put(`/api/workspaces/${encodeURIComponent(workspaceId)}/limits`, body);
    }),
  );

  const resaleShape = {
    cpu: z.number().min(1).max(100).optional(),
    memory: z.number().min(1).max(100).optional(),
    storage: z.number().min(1).max(100).optional().describe("Volumes"),
    egress: z.number().min(1).max(100).optional(),
    objectStorage: z.number().min(1).max(100).optional(),
    sandbox: z.number().min(1).max(100).optional(),
  };

  server.registerTool(
    "workspace_resale_pricing_get",
    {
      title: "Read resale prices",
      description:
        "Read the prices a workspace's scoped API keys are shown, as multiples of Lizard's (owner only, with a key that has no scopes). Returns enabled and multipliers per resource: cpu, memory, storage (volumes), egress, objectStorage, sandbox.",
      inputSchema: { workspaceId: z.string().min(1).describe("Workspace ID (see workspace_list)") },
      annotations: { title: "Read resale prices", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ workspaceId }) => ctx.api.get(`/api/workspaces/${encodeURIComponent(workspaceId)}/resale-pricing`)),
  );

  server.registerTool(
    "workspace_resale_pricing_set",
    {
      title: "Set resale prices",
      description:
        "For a reseller: set the prices that keys scoped to this workspace (or its projects) see, as multiples from 1 to 100 of Lizard's, per resource. " +
        "Resources not passed keep their current multiplier; off: true turns resale prices off. Only what scoped keys are shown changes: the owner's dashboard, unscoped keys and the owner's bill keep Lizard's prices. Owner only, with a key that has no scopes.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace ID (see workspace_list)"),
        ...resaleShape,
        off: z.boolean().optional().describe("Turn resale prices off"),
      },
      annotations: { title: "Set resale prices", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ workspaceId, off, ...given }) => {
      const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/resale-pricing`;
      if (off) return ctx.api.put(path, {});
      const changes = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));
      if (!Object.keys(changes).length) throw new Error("Pass at least one multiplier, or off: true.");
      const current = await ctx.api.get<{ multipliers?: Record<string, number> }>(path);
      return ctx.api.put(path, { ...(current.multipliers ?? {}), ...changes });
    }),
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Use this when you need to identify the currently authenticated Lizard user, e.g. before asking which workspace or project to act on.",
      inputSchema: {},
      annotations: { title: "Who am I", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      annotations: { title: "List workspaces", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      annotations: { title: "List projects", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      annotations: { title: "Create project", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
      annotations: { title: "List regions", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async () => ctx.api.get("/api/regions")),
  );
}
