import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { withScope } from "../lib/api.js";
import { resolveProject, resolveService } from "../lib/resolve.js";
import { handle, REVEAL_ANNOTATIONS, revealMoved } from "../lib/tool-helpers.js";
import { redactServiceDetails } from "../lib/service-redaction.js";

interface Secret {
  key: string;
  value: string;
}

export function registerSecretsTools(server: McpServer, ctx: ToolContext) {
  async function readSecrets(project: string, service?: string): Promise<Secret[]> {
    const proj = await resolveProject(ctx.api, project);
    const scope = { workspaceId: proj.workspaceId };
    const path = service
      ? `/api/apps/${(await resolveService(ctx.api, proj.id, service, scope)).id}/secrets`
      : `/api/projects/${proj.id}/secrets`;
    return ctx.api.get<Secret[]>(withScope(path, scope));
  }

  server.registerTool(
    "secrets_list",
    {
      title: "List secrets",
      description:
        "Use this when the user wants to see which environment variables/secrets are configured for a Lizard service or project. Values are always masked; use secrets_reveal only when the user asks to see them.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1).optional().describe("Omit for project-wide (global) secrets"),
        reveal: z.boolean().optional().describe("No longer supported: use secrets_reveal"),
      },
      annotations: { title: "List secrets", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service, reveal }) => {
      if (reveal) throw revealMoved("secrets_reveal");
      return (await readSecrets(project, service)).map((s) => ({ key: s.key, value: "***" }));
    }),
  );

  server.registerTool(
    "secrets_reveal",
    {
      title: "Reveal secret values",
      description:
        "Show the plaintext values of the environment variables/secrets of a Lizard service or project. Only when the user explicitly asks to see them: ask first, then pass confirm:true. Use secrets_list to see just the keys.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1).optional().describe("Omit for project-wide (global) secrets"),
        confirm: z.literal(true).describe("The user asked to see these values in this conversation"),
      },
      annotations: { title: "Reveal secret values", ...REVEAL_ANNOTATIONS },
    },
    handle(async ({ project, service }) => readSecrets(project, service)),
  );

  server.registerTool(
    "secrets_set",
    {
      title: "Set secrets",
      description:
        "Use this when the user wants to set one or more environment variables/secrets on a Lizard service or project. Overwrites existing values with the same key. Credentials in the response are masked; use secrets_reveal only when the user asks for them.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1).optional().describe("Omit to set project-wide (global) secrets"),
        values: z.record(z.string(), z.string()).describe("Key-value pairs to set"),
      },
      annotations: { title: "Set secrets", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service, values }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const payload = service
        ? { secrets: { services: { [(await resolveService(ctx.api, proj.id, service, scope)).name]: values } } }
        : { secrets: { shared: values } };
      return ctx.api.post(withScope(`/api/projects/${proj.id}/config:apply`, scope), payload).then(redactServiceDetails);
    }),
  );

  server.registerTool(
    "secrets_delete",
    {
      title: "Delete secrets",
      description:
        "Use this when the user wants to remove one or more environment variables/secrets from a Lizard service or project. This is destructive and cannot be undone — requires explicit confirmation. Credentials in the response are masked.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1).optional(),
        keys: z.array(z.string()),
        confirm: z.literal(true).describe("Must be true to proceed; there is no interactive confirmation in MCP"),
      },
      annotations: { title: "Delete secrets", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project, service, keys }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const svc = service ? await resolveService(ctx.api, proj.id, service, scope) : undefined;

      // Verify every key actually exists before deleting anything — a typo'd
      // key would otherwise silently "succeed" with nothing actually removed
      // and no signal to the caller, matching lizard-cli's own delete guard.
      const getPath = svc ? `/api/apps/${svc.id}/secrets` : `/api/projects/${proj.id}/secrets`;
      const existing = await ctx.api.get<Secret[]>(withScope(getPath, scope));
      const existingKeys = new Set(existing.map((s) => s.key));
      const notFound = keys.filter((k) => !existingKeys.has(k));
      if (notFound.length > 0) {
        throw new Error(`Secret(s) not found: ${notFound.join(", ")}`);
      }

      const nulls = Object.fromEntries(keys.map((k) => [k, null]));
      const payload = svc ? { secrets: { services: { [svc.name]: nulls } } } : { secrets: { shared: nulls } };
      return ctx.api.post(withScope(`/api/projects/${proj.id}/config:apply`, scope), payload).then(redactServiceDetails);
    }),
  );

  server.registerTool(
    "secrets_refs",
    {
      title: "List variable references",
      description:
        "Use this when the user wants to see the available reference-variable templates (like postgres connection strings) they can inject into another service's secrets.",
      inputSchema: { project: z.string().min(1), service: z.string().min(1).optional() },
      annotations: { title: "List variable references", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const path = service
        ? `/api/apps/${(await resolveService(ctx.api, proj.id, service, scope)).id}/variables:refs`
        : `/api/projects/${proj.id}/variables:refs`;
      return ctx.api.get(withScope(path, scope));
    }),
  );
}

