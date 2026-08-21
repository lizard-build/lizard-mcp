import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { withQuery } from "../lib/api.js";
import { handle } from "../lib/tool-helpers.js";

export function registerAccountTools(server: McpServer, ctx: ToolContext) {
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
