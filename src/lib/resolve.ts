import { withQuery, withScope, type ApiClient, type ResourceScope } from "./api.js";

interface Project {
  id: string;
  name: string;
  slug: string;
  workspaceId?: string | null;
}

interface AppLite {
  id: string;
  name: string;
  status?: string;
}

interface AddonLite {
  id: string;
  name: string;
  addonType?: string;
  status?: string;
}

interface ServicesResponse {
  apps?: AppLite[];
  addons?: AddonLite[];
}

export interface ResolvedService {
  id: string;
  name: string;
  kind: "app" | "addon";
}

/**
 * Resolves a project name, slug, or ID against GET /api/projects.
 *
 * Unlike lizard-cli's resolve.ts (which falls back to the cwd-linked project
 * in .lizard/config.json when no flag is given, and silently takes the first
 * case-insensitive match on ambiguity), lizard-mcp has no cwd — callers must
 * always pass an explicit identifier — and ambiguous matches are a hard error
 * listing every candidate, rather than a silent pick. An LLM-driven caller
 * acting on the wrong same-named project silently is worse than one extra
 * round-trip to disambiguate by ID.
 */
export async function resolveProject(
  api: ApiClient,
  nameOrSlugOrId: string,
  workspaceId?: string,
): Promise<Project> {
  const projects = await api.get<Project[]>(withQuery("/api/projects", { workspaceId }));

  const byId = projects.filter((p) => p.id === nameOrSlugOrId);
  if (byId.length === 1) return byId[0];

  const lower = nameOrSlugOrId.toLowerCase();
  const byNameOrSlug = projects.filter(
    (p) => p.slug.toLowerCase() === lower || p.name.toLowerCase() === lower,
  );

  if (byNameOrSlug.length === 1) return byNameOrSlug[0];

  if (byNameOrSlug.length > 1) {
    const candidates = byNameOrSlug.map((p) => `${p.name} (id: ${p.id}, workspace: ${p.workspaceId ?? "?"})`);
    throw new Error(
      `"${nameOrSlugOrId}" matches ${byNameOrSlug.length} projects. Pass the exact ID instead: ${candidates.join("; ")}`,
    );
  }

  const available = projects.map((p) => p.name).join(", ");
  throw new Error(`Project "${nameOrSlugOrId}" not found. Available: ${available || "none"}.`);
}

/**
 * Resolves a service (app or addon) within a project by name or ID against
 * GET /api/projects/{projectId}/services. Same fail-loud-on-ambiguity policy
 * as resolveProject.
 */
export async function resolveService(
  api: ApiClient,
  projectId: string,
  nameOrId: string,
  scope?: ResourceScope,
): Promise<ResolvedService> {
  const data = await api.get<ServicesResponse>(
    withScope(`/api/projects/${projectId}/services`, scope),
  );
  const apps = data.apps || [];
  const addons = data.addons || [];

  const appsById = apps.filter((a) => a.id === nameOrId);
  if (appsById.length === 1) return { id: appsById[0].id, name: appsById[0].name, kind: "app" };
  const addonsById = addons.filter((a) => a.id === nameOrId);
  if (addonsById.length === 1) {
    return { id: addonsById[0].id, name: addonsById[0].name || addonsById[0].addonType || "", kind: "addon" };
  }

  const lower = nameOrId.toLowerCase();
  const appMatches = apps.filter((a) => a.name?.toLowerCase() === lower);
  const addonMatches = addons.filter(
    (a) => a.name?.toLowerCase() === lower || a.addonType?.toLowerCase() === lower,
  );
  const allMatches = [
    ...appMatches.map((a) => ({ id: a.id, name: a.name, kind: "app" as const })),
    ...addonMatches.map((a) => ({ id: a.id, name: a.name || a.addonType || "", kind: "addon" as const })),
  ];

  if (allMatches.length === 1) return allMatches[0];

  if (allMatches.length > 1) {
    const candidates = allMatches.map((m) => `${m.name} (id: ${m.id}, ${m.kind})`);
    throw new Error(
      `"${nameOrId}" matches ${allMatches.length} services in this project. Pass the exact ID instead: ${candidates.join("; ")}`,
    );
  }

  const available = [...apps.map((a) => a.name), ...addons.map((a) => a.name || a.addonType)].filter(Boolean);
  throw new Error(
    `Service "${nameOrId}" not found in project. ` +
      (available.length ? `Available: ${available.join(", ")}` : "No services exist."),
  );
}
