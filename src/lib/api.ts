const DEFAULT_BASE_URL = "https://lizard.build";
const baseURL = process.env.PLATFORM_URL || DEFAULT_BASE_URL;
const USER_AGENT = "lizard-mcp/0.1.0";

export interface ResourceScope {
  workspaceId?: string | null;
}

export function withQuery(
  path: string,
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  if (!query) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

export function withScope(path: string, scope?: ResourceScope): string {
  if (!scope) return path;
  return withQuery(path, { workspaceId: scope.workspaceId });
}

export class APIError extends Error {
  status: number;
  code: string;
  body: unknown;
  constructor(status: number, message: string, code = "", body: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof APIError && err.status === 404;
}

/**
 * Builds a REST client bound to one caller's access token. Unlike
 * lizard-cli's `api.ts` (a single process authenticated as one user for its
 * whole lifetime, so the token lives in module state), lizard-mcp is a
 * stateless multi-tenant HTTP service handling concurrent requests from
 * different users — the token must be a parameter, not global mutable state.
 */
export function createApiClient(accessToken: string) {
  async function request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${accessToken}`,
      ...extraHeaders,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(baseURL + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let msg = res.statusText;
      let code = "";
      let parsedBody: unknown = null;
      try {
        const j = (await res.json()) as any;
        parsedBody = j;
        msg = j.error || j.message || msg;
        code = j.code || "";
      } catch {}
      throw new APIError(res.status, msg, code, parsedBody);
    }

    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  return {
    get: <T = any>(path: string) => request<T>("GET", path),
    post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>("POST", path, body, headers),
    patch: <T = any>(path: string, body?: unknown) => request<T>("PATCH", path, body),
    delete: <T = any>(path: string) => request<T>("DELETE", path),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
