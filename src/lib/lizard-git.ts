import { apiErrorFrom, APIError, fetchWithCause, NO_TOKEN_MESSAGE } from "./api.js";

/**
 * Lizard Git (lizard.build/git) with the caller's own token, the way lizard-cli's
 * lib/lizard-git.ts talks to it: `Authorization: Bearer <token>`, so OAuth tokens and
 * liz_ keys both work (Lizard Git asks the platform whose token it is). The SDK sends
 * X-API-Key instead, which only fits API keys — one reason this server keeps its own client.
 *
 * Scoped API keys are refused by Lizard Git: they don't say which repositories they reach.
 */

/** LIZARD_GIT_URL, else <PLATFORM_URL>/git (https://lizard.build/git). */
export function gitURL(): string {
  const explicit = process.env.LIZARD_GIT_URL;
  const base = (explicit || `${process.env.PLATFORM_URL || "https://lizard.build"}/git`).replace(/\/+$/, "");
  const parsed = new URL(base);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  // The caller's token goes there with every request.
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new Error(`Lizard Git address must be https, got ${base}`);
  }
  return base;
}

export const seg = encodeURIComponent;

/** A branch or file path, each part escaped; . and .. parts refused (they'd reach other API paths). */
export function segs(p: string): string {
  const parts = p.split("/");
  if (parts.some((x) => x === "" || x === "." || x === "..")) throw new Error(`bad path: "${p}"`);
  return parts.map(seg).join("/");
}

/** "owner/name" -> /api/repos/owner/name. */
export function repoPath(repo: string): string {
  const m = /^([^/\s]+)\/([^/\s]+?)(\.git)?$/.exec(repo);
  if (!m || [m[1], m[2]].some((x) => x === "." || x === "..")) throw new Error(`repository must be "owner/name", got "${repo}"`);
  return `/api/repos/${seg(m[1])}/${seg(m[2])}`;
}

export function qs(path: string, values: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null && v !== "" && v !== false) q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export function createGitClient(accessToken: string) {
  async function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    if (!accessToken) throw new APIError(401, NO_TOKEN_MESSAGE);
    const res = await fetchWithCause(gitURL() + path, {
      method,
      headers: {
        "User-Agent": "lizard-mcp/0.1.0",
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error", // a redirect would carry the token to wherever it points
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      let parsed: unknown = null;
      try { parsed = await res.json(); } catch {}
      throw apiErrorFrom(res.status, res.statusText, parsed);
    }
    return res;
  }
  async function json<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const res = await send(method, path, body, headers);
    const text = res.status === 204 ? "" : await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  return {
    get: <T = any>(path: string) => json<T>("GET", path),
    post: <T = any>(path: string, body: unknown = {}, headers?: Record<string, string>) => json<T>("POST", path, body, headers),
    delete: <T = any>(path: string) => json<T>("DELETE", path),
    text: async (path: string) => (await send("GET", path)).text(),
  };
}

export type GitClient = ReturnType<typeof createGitClient>;
