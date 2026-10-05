import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { APIError } from "../lib/api.js";
import { resolveProject } from "../lib/resolve.js";
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

/** Exported so unit tests can validate the input schema directly. The server
 *  enforces the per-project min/max (GET /volume-limits); only the floor of 1
 *  is checked here so a max change on the platform never needs a release. */
export const volumeResizeShape = {
  project: z.string().min(1).describe("Project name, slug, or ID"),
  volume: z.string().min(1).describe("Volume name or ID (from volume_list)"),
  sizeGb: z.number().int().min(1).describe("New size in GB (whole number, at least 1)"),
};

export function registerVolumeTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "volume_list",
    {
      title: "List volumes",
      description:
        "Use this when the user wants to see the persistent sandbox volumes in a Lizard project — name, id, size (sizeGb), status, region, how much is used (lastUsedBytes), and which sandbox it is attached to (attachedSandboxId), if any.",
      inputSchema: { project: z.string().min(1).describe("Project name, slug, or ID") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project }) => {
      const proj = await resolveProject(ctx.api, project);
      return ctx.api.get(buildVolumeListPath(proj.id));
    }),
  );

  server.registerTool(
    "volume_resize",
    {
      title: "Resize volume",
      description:
        "Use this when the user wants to grow or shrink a persistent sandbox volume. The resize happens in place and online: the size is a filesystem quota, no data is copied, it completes in well under a second, and an attached sandbox keeps running. " +
        "Both growing and shrinking are allowed, but a shrink must leave at least 10% of the new size free — check lastUsedBytes in volume_list first and pick a size comfortably above it. Calling again with the current size is a no-op. " +
        "Allowed sizes are per-project (minSizeGb/maxSizeGb from GET /api/projects/:projectId/volume-limits); the server rejects anything outside that range with invalid_volume_size, so do not assume a maximum. " +
        "Returns the updated volume plus sizeEnforced (whether the quota is actually enforced on the backing storage). " +
        "Error codes: invalid_volume_size, volume_not_resizable, volume_too_full_to_shrink (choose a larger size), volume_resize_in_progress (retry shortly), volume_not_provisioned, volume_capacity_unavailable (not enough room on the node to grow), volume_resize_timeout (size was left unchanged; safe to retry).",
      inputSchema: volumeResizeShape,
      // destructiveHint false: a resize never deletes or copies data, and the
      // only risk (shrinking below usage) is refused server-side by the 10%-free
      // guard. Matches the repo convention of reserving destructiveHint/confirm
      // for tools that remove things (service_delete, domain_delete, ...).
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, volume, sizeGb }) => {
      const proj = await resolveProject(ctx.api, project);
      try {
        return await ctx.api.patch(buildVolumeResizePath(proj.id, volume), buildVolumeResizeBody(sizeGb));
      } catch (err) {
        // handle() only surfaces err.message; keep the machine-readable code
        // visible so the model can act on it (e.g. volume_too_full_to_shrink).
        if (err instanceof APIError && err.code) throw new APIError(err.status, `${err.message} (${err.code})`, err.code, err.body);
        throw err;
      }
    }),
  );
}
