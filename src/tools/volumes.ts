import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { APIError, withScope } from "../lib/api.js";
import { resolveProject, resolveService } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

/** Collection path for a project's volumes. Exported for unit tests. */
export function buildVolumeListPath(projectId: string): string {
  return `/api/projects/${projectId}/volumes`;
}

/** The resize endpoint accepts an id or a name for the volume segment, so it
 *  is URL-encoded — a name is user-chosen text, not a safe path segment. */
export function buildVolumeResizePath(projectId: string, nameOrId: string): string {
  return `/api/projects/${projectId}/volumes/${encodeURIComponent(nameOrId)}`;
}

export function buildVolumeResizeBody(sizeGb: number): { sizeGb: number } {
  return { sizeGb };
}

/** Matches lizard-cli's VOLUME_NAME_RE. */
export const VOLUME_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/** Exported so unit tests can validate the input schema directly. The server
 *  enforces the per-project min/max (GET /volume-limits); only the floor of 1
 *  is checked here so a max change on the platform never needs a release. */
export const volumeResizeShape = {
  project: z.string().min(1).describe("Project name, slug, or ID"),
  volume: z.string().min(1).describe("Volume name or ID (from volume_list)"),
  sizeGb: z.number().int().min(1).describe("New size in GB (whole number, at least 1)"),
};

interface VolumeRecord { id: string; name: string; sizeGb: number; attachedTo?: string | null; attachedSandboxId?: string | null }

/** Keeps the machine-readable code in the message, since handle() only surfaces err.message. */
function withCode(err: unknown): never {
  if (err instanceof APIError && err.code && !err.message.includes(err.code)) {
    throw new APIError(err.status, `${err.message} (${err.code})`, err.code, err.body);
  }
  throw err;
}

async function appOf(ctx: ToolContext, projectId: string, workspaceId: string | null | undefined, service: string) {
  const svc = await resolveService(ctx.api, projectId, service, { workspaceId });
  if (svc.kind !== "app") throw new Error(`${svc.name} is a managed database; its storage is managed for you (service_scale storage).`);
  return svc;
}

export function registerVolumeTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "volume_list",
    {
      title: "List volumes",
      description:
        "Use this when the user wants to see persistent volumes. Without service: the project's sandbox volumes — name, id, size (sizeGb), status, region, how much is used (lastUsedBytes), and the sandbox it is attached to, if any. With service: the volume attached to that app and where it is mounted.",
      inputSchema: {
        project: z.string().min(1).describe("Project name, slug, or ID"),
        service: z.string().min(1).optional().describe("An app name or ID: list its volume instead"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service }) => {
      const proj = await resolveProject(ctx.api, project);
      if (service) {
        const app = await appOf(ctx, proj.id, proj.workspaceId, service);
        return ctx.api.get(`/api/apps/${app.id}/volumes`);
      }
      return ctx.api.get(withScope(buildVolumeListPath(proj.id), { workspaceId: proj.workspaceId }));
    }),
  );

  server.registerTool(
    "volume_create",
    {
      title: "Create volume",
      description:
        "Create a persistent volume. Without service: a sandbox volume in the project, to attach with sandbox_create's volume (it must be in the sandbox's region); the size defaults to the project's default and must be within its limits. " +
        "With service: a volume attached to that app at mountPath (default /data), one per app; the app restarts with it mounted and files there survive restarts and redeploys. Volumes are billed for their size until deleted.",
      inputSchema: {
        project: z.string().min(1).describe("Project name, slug, or ID"),
        name: z.string().regex(VOLUME_NAME_RE).describe("Lowercase letters, digits and dashes, up to 64"),
        sizeGb: z.number().int().min(1).optional().describe("Size in GB"),
        region: z.string().min(1).optional().describe("Sandbox volumes: region code (region_list)"),
        service: z.string().min(1).optional().describe("App name or ID to attach the volume to"),
        mountPath: z.string().regex(/^\//).optional().describe("With service: absolute path, default /data"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project, name, sizeGb, region, service, mountPath }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      if (service) {
        const app = await appOf(ctx, proj.id, proj.workspaceId, service);
        return ctx.api
          .post(`/api/apps/${app.id}/volumes`, { name, sizeGb: sizeGb ?? 5, mountPath: mountPath ?? "/data" })
          .catch(withCode);
      }
      if (mountPath) throw new Error("mountPath applies only with service; a sandbox mounts its volume at /workspace.");
      let size = sizeGb;
      if (size === undefined) {
        const limits = await ctx.api.get<{ defaultSizeGb: number }>(withScope(`/api/projects/${proj.id}/volume-limits`, scope));
        size = limits.defaultSizeGb;
      }
      return ctx.api
        .post(withScope(buildVolumeListPath(proj.id), scope), { name, sizeGb: size, ...(region ? { region } : {}) })
        .catch(withCode);
    }),
  );

  server.registerTool(
    "volume_resize",
    {
      title: "Resize volume",
      description:
        "Use this when the user wants a bigger persistent sandbox volume. It grows in place and online: no data is copied and an attached sandbox keeps running. " +
        "A volume cannot shrink (volume_shrink_unsupported), except an older one, which can if at least 10% of the new size stays free (volume_too_full_to_shrink otherwise). Calling again with the current size is a no-op. " +
        "Allowed sizes are per project (minSizeGb/maxSizeGb); the server rejects anything outside that range with invalid_volume_size, so do not assume a maximum. " +
        "Returns the updated volume. grownInSandbox false means the attached sandbox still sees the old size until a sandbox next mounts the volume; sizeEnforced false means the region does not enforce the size as a hard limit. " +
        "Other error codes: volume_not_resizable, volume_resize_in_progress (retry shortly), volume_not_provisioned, volume_capacity_unavailable (no room on the machine to grow), volume_resize_timeout (size left unchanged; safe to retry).",
      inputSchema: volumeResizeShape,
      // destructiveHint false: growing never deletes or copies data, and the
      // only risky case (shrinking an older volume below its usage) is refused
      // server-side by the 10%-free guard. Matches the repo convention of
      // reserving destructiveHint/confirm for tools that remove things.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, volume, sizeGb }) => {
      const proj = await resolveProject(ctx.api, project);
      return ctx.api
        .patch(withScope(buildVolumeResizePath(proj.id, volume), { workspaceId: proj.workspaceId }), buildVolumeResizeBody(sizeGb))
        .catch(withCode);
    }),
  );

  server.registerTool(
    "volume_delete",
    {
      title: "Delete volume",
      description:
        "Permanently delete a sandbox volume and every file on it. A volume attached to a sandbox can't be deleted: delete the sandbox first. Get the user's approval before calling; this cannot be undone.",
      inputSchema: {
        project: z.string().min(1).describe("Project name, slug, or ID"),
        volume: z.string().min(1).describe("Volume name or ID (from volume_list)"),
        confirm: z.literal(true).describe("Set only after the user approves deleting this volume and its files"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project, volume }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const volumes = await ctx.api.get<VolumeRecord[]>(withScope(buildVolumeListPath(proj.id), scope));
      const target = volumes.find((v) => v.id === volume) ?? volumes.find((v) => v.name === volume);
      if (!target) throw new Error(`Volume "${volume}" not found in project. Available: ${volumes.map((v) => v.name).join(", ") || "none"}.`);
      const attached = target.attachedTo ?? target.attachedSandboxId;
      if (attached) throw new Error(`Volume "${target.name}" is attached to sandbox ${attached}. Delete the sandbox first.`);
      await ctx.api.delete(withScope(buildVolumeResizePath(proj.id, target.name), scope)).catch(withCode);
      return { id: target.id, name: target.name, status: "deleted" };
    }),
  );
}
