import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { APIError } from "./api.js";

/**
 * structuredContent is only included for plain object/array results — the
 * MCP spec requires it to be a JSON object, so string/number/null results
 * (e.g. a bare status message) skip it and rely on the text content block.
 */
export function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data === undefined ? { ok: true } : data, null, 2);
  const isPlainObject = typeof data === "object" && data !== null;
  return {
    content: [{ type: "text", text }],
    ...(isPlainObject ? { structuredContent: Array.isArray(data) ? { items: data } : (data as Record<string, unknown>) } : {}),
  };
}

export function errResult(message: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    ...(structured ? { structuredContent: structured } : {}),
  };
}

const LINK_FIELDS = ["subscribeUrl", "billingUrl", "topupUrl", "invoiceUrl"] as const;

/**
 * The error a tool returns for a failed platform call. The text is the platform's
 * sentence plus the page to open (see apiErrorFrom); structuredContent carries the
 * HTTP status, the code, the 402 `status` and the links, for clients that branch on them.
 */
export function apiErrResult(err: APIError): CallToolResult {
  const body = (err.body && typeof err.body === "object" ? err.body : {}) as Record<string, unknown>;
  const detail: Record<string, unknown> = { status: err.status };
  if (err.code) detail.code = err.code;
  if (typeof body.status === "string") detail.paymentStatus = body.status;
  for (const key of LINK_FIELDS) if (typeof body[key] === "string") detail[key] = body[key];
  return errResult(err.message, { error: detail });
}

/**
 * Wraps a tool handler so a thrown Error (APIError, resolve.ts's
 * not-found/ambiguous errors, etc.) becomes a proper CallToolResult with
 * isError:true instead of an unhandled rejection — every tools/*.ts file
 * wraps its handlers with this instead of repeating try/catch everywhere.
 */
export function handle<Args extends unknown[]>(
  fn: (...args: Args) => Promise<unknown>,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args) => {
    try {
      const result = await fn(...args);
      return ok(result);
    } catch (err) {
      if (err instanceof APIError) return apiErrResult(err);
      return errResult(err instanceof Error ? err.message : String(err));
    }
  };
}
