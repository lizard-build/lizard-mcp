import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { withQuery } from "../lib/api.js";
import { handle, ok, errResult } from "../lib/tool-helpers.js";

export function registerTemplateTools(server: McpServer, ctx: ToolContext) {
  server.registerTool("template_list", {
    title: "List templates",
    description: "Find published app templates to deploy. Set mine to list your own templates, including private ones. Use template_show to inspect required variables before deploying.",
    inputSchema: { mine: z.boolean().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handle(async ({ mine }) => ctx.api.get(withQuery("/api/templates", { mine: mine ? 1 : undefined }))));

  server.registerTool("template_show", {
    title: "Show template",
    description: "Read a template's services, addons and required variables before deployment. Pass the ID or slug returned by template_list.",
    inputSchema: { template: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handle(async ({ template }) => ctx.api.get(`/api/templates/${encodeURIComponent(template)}`)));

  server.registerTool("template_deploy", {
    title: "Deploy template",
    description: "Deploy a template as a new project in the chosen workspace. Read template_show first and supply required placeholderValues. Each call creates another project and may incur charges. Do not retry a partial failure blindly: inspect the returned project first.",
    inputSchema: {
      template: z.string().min(1).describe("Template ID or slug"),
      projectName: z.string().min(1).max(100),
      workspaceId: z.string().min(1),
      placeholderValues: z.record(z.string(), z.string()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ template, projectName, workspaceId, placeholderValues }) => {
    try {
      const result = await ctx.api.post<{ errors?: unknown[] }>(`/api/templates/${encodeURIComponent(template)}/deploy`, {
        projectName, workspaceId, placeholderValues: placeholderValues ?? {},
      });
      return { ...ok(result), ...(result.errors?.length ? { isError: true } : {}) };
    } catch (error) { return errResult(error instanceof Error ? error.message : String(error)); }
  });
}
