import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { withScope } from "../lib/api.js";
import { resolveProject, resolveService } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

/** 1024 -> "1Gi", 512 -> "512Mi". Matches lizard-cli/src/commands/scale.ts's mbToK8s. */
function mbToK8s(mb: number): string {
  return mb % 1024 === 0 ? `${mb / 1024}Gi` : `${mb}Mi`;
}

/** Inverse of mbToK8s, for the addon storage grow-only comparison. */
function parseStorageToMb(size: string): number {
  if (size.endsWith("Gi")) return parseFloat(size) * 1024;
  if (size.endsWith("Mi")) return parseFloat(size);
  if (size.endsWith("Ti")) return parseFloat(size) * 1024 * 1024;
  return 0;
}

interface ScaleTargets {
  replicas?: number;
  cpu?: number;
  memory?: number;
  storage?: number;
}

/**
 * Guards the app-vs-addon axis split for service.scale — replicas is
 * apps-only (addons run as a single instance), storage is addons-only (apps have
 * no resizable data volume on this path). Exported so unit tests can cover
 * every combination without needing a live/mocked API resolution chain.
 */
export function validateScaleTargets(kind: "app" | "addon", targets: ScaleTargets): void {
  const { replicas, cpu, memory, storage } = targets;
  if (replicas === undefined && cpu === undefined && memory === undefined && storage === undefined) {
    throw new Error("Pass at least one of: replicas, cpu, memory, storage.");
  }
  if (kind === "addon" && replicas !== undefined) {
    throw new Error("Addons run as a single instance and don't support replicas.");
  }
  if (kind === "app" && storage !== undefined) {
    throw new Error("storage is only supported for addons.");
  }
}

interface ServicesResponse {
  apps?: { id: string; name: string }[];
  addons?: { id: string; name: string; addonType?: string }[];
}

/** config:apply can partially succeed and report deferred side-effect
 *  failures (e.g. the DB write succeeds but the pod resize doesn't) — surface
 *  these to the caller instead of silently dropping them, matching how
 *  lizard-cli's scale.ts warns on the same field. */
interface ConfigApplyResult {
  revision?: number;
  sideEffectFailures?: { op: string; error: string }[];
}

/** Exported so unit tests can validate the constraint-encoding directly,
 *  without duplicating a second copy of these rules in the test file. */
export const serviceScaleShape = {
  project: z.string().min(1),
  service: z.string().min(1),
  replicas: z.number().int().min(1).max(10).optional().describe("Apps only"),
  cpu: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional().describe("CPU cores, apps only"),
  memory: z.number().int().min(128).max(8192).optional().describe("Memory in MB, apps only"),
  storage: z
    .union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096), z.literal(8192), z.literal(16384)])
    .optional()
    .describe("Storage in MB, addons only, grow-only"),
};

export function registerServiceTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "service_list",
    {
      title: "List services",
      description: "Use this when the user wants to see all apps and addons in a Lizard project.",
      inputSchema: { project: z.string().min(1).describe("Project name, slug, or ID") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project }) => {
      const proj = await resolveProject(ctx.api, project);
      return ctx.api.get(withScope(`/api/projects/${proj.id}/services`, { workspaceId: proj.workspaceId }));
    }),
  );

  server.registerTool(
    "service_show",
    {
      title: "Show service details",
      description:
        "Use this when the user wants details about a single Lizard service (app or addon) — status, config, resource limits.",
      inputSchema: { project: z.string().min(1), service: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const svc = await resolveService(ctx.api, proj.id, service, scope);
      if (svc.kind === "app") return ctx.api.get(`/api/apps/${svc.id}`);
      const data = await ctx.api.get<ServicesResponse>(withScope(`/api/projects/${proj.id}/services`, scope));
      return data.addons?.find((a) => a.id === svc.id) ?? null;
    }),
  );

  server.registerTool(
    "service_create",
    {
      title: "Create service",
      description:
        "Use this when the user wants to create a new empty Lizard service, or deploy a GitHub repository as a new service. Omit repoUrl for an empty service you configure later; provide repoUrl to deploy that repo immediately. Calling this again creates another service, even with the same name — it does not update an existing one. A *.onlizard.com domain is assigned automatically, but not until the build finishes and the service boots — this response's `domain` field will be null right after creation, that is expected, not an error. Do not invent, guess, or predict a hostname to fill that gap. Tell the user the deploy is in progress and the domain isn't assigned yet; poll service_show or deploy_events and report the real `domain` value once it's non-null.",
      inputSchema: {
        project: z.string().min(1),
        name: z.string().describe("Service name"),
        region: z.string().describe("Deployment region code — call region_list first if unsure of valid values, do not guess"),
        repoUrl: z.string().optional().describe("GitHub repo URL — when provided, this becomes a deploy of that repo"),
        containerPort: z.number().int().optional(),
        envVars: z.record(z.string(), z.string()).optional(),
        skipInitialDeploy: z.boolean().optional().describe("With repoUrl: attach the repo but skip the initial build"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project, name, region, repoUrl, containerPort, envVars, skipInitialDeploy }) => {
      const proj = await resolveProject(ctx.api, project);
      return ctx.api.post(
        withScope(`/api/projects/${proj.id}/apps`, { workspaceId: proj.workspaceId }),
        { name, region, repoUrl, containerPort, envVars, skipInitialDeploy },
      );
    }),
  );

  server.registerTool(
    "addon_create",
    {
      title: "Create addon",
      description:
        "Use this when the user wants to provision a managed database or storage addon (Postgres, Redis, or S3) in a Lizard project. Calling this again creates another addon, even with the same name — it does not update an existing one.",
      inputSchema: {
        project: z.string().min(1),
        type: z.enum(["postgres", "redis", "s3"]),
        region: z.string().describe("Deployment region code — call region_list first if unsure of valid values, do not guess"),
        name: z.string().optional().describe("Stable reference key for ${{name.KEY}} templates"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project, type, region, name }) => {
      const proj = await resolveProject(ctx.api, project);
      return ctx.api.post(
        withScope(`/api/projects/${proj.id}/addons`, { workspaceId: proj.workspaceId }),
        { type, region, name },
      );
    }),
  );

  server.registerTool(
    "service_rename",
    {
      title: "Rename service",
      description: "Use this when the user wants to rename an existing Lizard service.",
      inputSchema: { project: z.string().min(1), service: z.string().min(1), name: z.string().describe("New name") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service, name }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const svc = await resolveService(ctx.api, proj.id, service, scope);
      if (svc.kind === "app") {
        return ctx.api.post(withScope(`/api/projects/${proj.id}/config:apply`, scope), {
          services: [{ id: svc.id, name }],
        });
      }
      return ctx.api.patch(withScope(`/api/projects/${proj.id}/addons/${svc.id}`, scope), { name });
    }),
  );

  server.registerTool(
    "service_delete",
    {
      title: "Delete service",
      description:
        "Use this when the user wants to permanently delete a Lizard service (app or addon). This is destructive and cannot be undone — requires explicit confirmation.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1),
        confirm: z.literal(true).describe("Must be true to proceed; there is no interactive confirmation in MCP"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project, service }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const svc = await resolveService(ctx.api, proj.id, service, scope);
      if (svc.kind === "app") return ctx.api.delete(withScope(`/api/apps/${svc.id}`, scope));
      return ctx.api.delete(withScope(`/api/projects/${proj.id}/addons/${svc.id}`, scope));
    }),
  );

  server.registerTool(
    "service_scale",
    {
      title: "Scale service",
      description:
        "Use this when the user wants to change replica count, CPU, memory, or storage limits for a Lizard service.",
      inputSchema: serviceScaleShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service, replicas, cpu, memory, storage }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const svc = await resolveService(ctx.api, proj.id, service, scope);
      validateScaleTargets(svc.kind, { replicas, cpu, memory, storage });

      if (svc.kind === "addon") {
        return scaleAddon(ctx, proj.id, scope, svc, cpu, memory, storage);
      }

      const results: Record<string, unknown> = { id: svc.id };
      const calls: Promise<void>[] = [];

      if (replicas !== undefined) {
        calls.push(
          ctx.api.patch(`/api/apps/${svc.id}/scale`, { replicas }).then(() => {
            results.replicas = replicas;
          }),
        );
      }
      if (cpu !== undefined || memory !== undefined) {
        const entry: Record<string, unknown> = { id: svc.id, name: svc.name };
        if (cpu !== undefined) entry.cpuLimit = `${cpu * 1000}m`;
        if (memory !== undefined) entry.memoryLimit = mbToK8s(memory);
        calls.push(
          ctx.api
            .post<ConfigApplyResult>(withScope(`/api/projects/${proj.id}/config:apply`, scope), { services: [entry] })
            .then((r) => {
              if (cpu !== undefined) results.cpuLimit = `${cpu * 1000}m`;
              if (memory !== undefined) results.memoryLimit = mbToK8s(memory);
              if (r?.sideEffectFailures?.length) results.sideEffectFailures = r.sideEffectFailures;
            }),
        );
      }

      await Promise.all(calls);
      return results;
    }),
  );

  server.registerTool(
    "service_get_port",
    {
      title: "Get container port",
      description: "Use this when the user wants to know which container port a Lizard app is listening on.",
      inputSchema: { project: z.string().min(1), service: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const svc = await resolveService(ctx.api, proj.id, service, scope);
      if (svc.kind !== "app") throw new Error("Container port only applies to apps, not addons.");
      const app = await ctx.api.get<{ containerPort?: number }>(withScope(`/api/apps/${svc.id}`, scope));
      return { containerPort: app.containerPort };
    }),
  );

  server.registerTool(
    "service_set_port",
    {
      title: "Set container port",
      description: "Use this when the user wants to change the container port a Lizard app listens on.",
      inputSchema: { project: z.string().min(1), service: z.string().min(1), containerPort: z.number().int() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service, containerPort }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const svc = await resolveService(ctx.api, proj.id, service, scope);
      if (svc.kind !== "app") throw new Error("Container port only applies to apps, not addons.");
      return ctx.api.post(withScope(`/api/projects/${proj.id}/config:apply`, scope), {
        services: [{ id: svc.id, name: svc.name, containerPort }],
      });
    }),
  );

  server.registerTool(
    "service_set",
    {
      title: "Set service build/deploy config",
      description:
        "Use this when the user wants to change a Lizard service's build/deploy configuration — source repo, branch, build command, start command, etc.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1),
        sourceType: z.string().optional(),
        repoUrl: z.string().optional(),
        branch: z.string().optional(),
        rootDirectory: z.string().optional(),
        buildCommand: z.string().optional(),
        watchPatterns: z.array(z.string()).optional(),
        dockerfilePath: z.string().optional(),
        startCommand: z.string().optional(),
        preDeployCommand: z.string().optional(),
        containerPort: z.number().int().optional(),
        force: z.boolean().optional().describe("Skip the optimistic-concurrency revision check"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service, force, ...fields }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const svc = await resolveService(ctx.api, proj.id, service, scope);

      const entry: Record<string, unknown> = { id: svc.id };
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) entry[key] = value;
      }

      const body: Record<string, unknown> = { services: [entry] };
      if (!force) {
        // Non-fatal: matches lizard-cli's service-set.ts, which treats a
        // failed project fetch as "proceed without CAS" rather than failing
        // the whole write over an optional optimistic-concurrency check.
        try {
          const currentProject = await ctx.api.get<{ configRevision?: number | null }>(`/api/projects/${proj.id}`);
          if (currentProject?.configRevision != null) body.revision = currentProject.configRevision;
        } catch {}
      }

      return ctx.api.post(withScope(`/api/projects/${proj.id}/config:apply`, scope), body);
    }),
  );
}

async function scaleAddon(
  ctx: ToolContext,
  projectId: string,
  scope: { workspaceId?: string | null },
  service: { id: string; name: string },
  cpu: number | undefined,
  memory: number | undefined,
  storageMb: number | undefined,
): Promise<Record<string, unknown>> {
  if (storageMb !== undefined) {
    const addons = await ctx.api.get<{ id: string; config?: { storageSize?: string } }[]>(
      withScope(`/api/projects/${projectId}/addons`, scope),
    );
    const current = addons.find((a) => a.id === service.id);
    if (!current) throw new Error(`Addon "${service.name}" not found in project.`);
    const currentMb = current.config?.storageSize ? parseStorageToMb(current.config.storageSize) : 0;
    if (currentMb > 0 && storageMb <= currentMb) {
      throw new Error(`storage ${storageMb} MB is not larger than current ${currentMb} MB. Storage is grow-only.`);
    }
  }

  const addonPatch: Record<string, unknown> = { id: service.id };
  if (cpu !== undefined || memory !== undefined) {
    const limits: Record<string, number> = {};
    if (cpu !== undefined) limits.vcpu = cpu;
    if (memory !== undefined) limits.memoryMb = memory;
    addonPatch.limits = limits;
  }
  if (storageMb !== undefined) addonPatch.storageSize = mbToK8s(storageMb);

  const result = await ctx.api.post<ConfigApplyResult>(
    withScope(`/api/projects/${projectId}/config:apply`, scope),
    { addons: [addonPatch] },
  );

  return {
    id: service.id,
    kind: "addon",
    ...(cpu !== undefined ? { vcpu: cpu } : {}),
    ...(memory !== undefined ? { memoryMb: memory } : {}),
    ...(storageMb !== undefined ? { storageSize: mbToK8s(storageMb) } : {}),
    ...(result?.sideEffectFailures?.length ? { sideEffectFailures: result.sideEffectFailures } : {}),
  };
}
