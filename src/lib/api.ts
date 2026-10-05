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

/**
 * Only ever reachable from the stdio entry point: over HTTP a token is
 * present by the time a client is built, since requireBearerAuth already
 * verified one. See stdio.ts for why an empty token gets that far.
 */
export const NO_TOKEN_MESSAGE =
  "No Lizard API key. Create one with `lizard keys create`, then set LIZARD_TOKEN and restart the server.";

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

/** Old prepaid credits (`plan: "payg"`) statuses: the next step is the Credits page. */
const CREDITS_STATUSES = new Set(["grace", "frozen", "card_required", "credits_required"]);

function httpUrl(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : null;
}

/** The platform's "pay first" body: `code: "PAYMENT_REQUIRED"`, or `error: "INSUFFICIENT_CREDITS"` from older servers. */
export function isPaymentRequiredBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const j = body as Record<string, unknown>;
  return j.code === "PAYMENT_REQUIRED" || j.error === "INSUFFICIENT_CREDITS";
}

/**
 * The page an error body says to open next, with a label: the Pro trial or Start
 * Pro (`subscribeUrl`), an unpaid invoice, the Credits page for prepaid credits
 * accounts, or Billing (`billingUrl`). Null when the body has none.
 */
export function errorLink(body: unknown): { label: string; url: string } | null {
  if (!body || typeof body !== "object") return null;
  const j = body as Record<string, unknown>;
  const invoiceUrl = httpUrl(j.invoiceUrl);
  if (invoiceUrl) return { label: "Pay the open invoice", url: invoiceUrl };
  const billingUrl = httpUrl(j.billingUrl);
  if (!isPaymentRequiredBody(j)) return billingUrl ? { label: "Billing", url: billingUrl } : null;

  const subscribeUrl = httpUrl(j.subscribeUrl);
  const topupUrl = httpUrl(j.topupUrl);
  const status = typeof j.status === "string" ? j.status : "";
  if (status === "trial_available" && subscribeUrl) return { label: "Start the Pro trial", url: subscribeUrl };
  if (status === "subscription_required" && subscribeUrl) return { label: "Start Pro", url: subscribeUrl };
  if (CREDITS_STATUSES.has(status) && topupUrl) return { label: "Add credits", url: topupUrl };
  const url = billingUrl ?? subscribeUrl ?? topupUrl;
  return url ? { label: "Billing", url } : null;
}

/**
 * Builds the APIError for a failed call from its parsed JSON body (or null).
 *
 * Two shapes: most routes send {error: "human text"}; billing routes send
 * {error: "SCREAMING_CODE", message: "human text"}. For the second, the sentence is
 * the message and the code goes to `code` -- taking `error` alone handed the agent a
 * bare "INSUFFICIENT_CREDITS" with nothing to tell the user. A link the user has to
 * open (Billing, the Pro trial, an invoice) goes on the next line.
 */
export function apiErrorFrom(status: number, statusText: string, body: unknown): APIError {
  let msg = statusText;
  let code = "";
  if (body && typeof body === "object") {
    const j = body as Record<string, unknown>;
    const error = typeof j.error === "string" ? j.error : "";
    const message = typeof j.message === "string" ? j.message : "";
    const errIsCode = /^[A-Z][A-Z0-9_]*$/.test(error);
    msg = (errIsCode ? message || error : error) || message || msg;
    code = (typeof j.code === "string" && j.code) || (errIsCode ? error : "") || "";
    const next = errorLink(j);
    if (next) msg = `${msg}\n${next.label}: ${next.url}`;
  }
  return new APIError(status, msg, code, body);
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
    if (!accessToken) throw new APIError(401, NO_TOKEN_MESSAGE);

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
      let parsedBody: unknown = null;
      try {
        parsedBody = await res.json();
      } catch {}
      throw apiErrorFrom(res.status, res.statusText, parsedBody);
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
