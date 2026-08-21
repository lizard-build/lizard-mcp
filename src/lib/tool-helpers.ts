import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * structuredContent is only included for plain object/array results — the
 * MCP spec requires it to be a JSON object, so string/number/null results
 * (e.g. a bare status message) skip it and rely on the text content block.
 */
export function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const isPlainObject = typeof data === "object" && data !== null;
  return {
    content: [{ type: "text", text }],
    ...(isPlainObject ? { structuredContent: Array.isArray(data) ? { items: data } : (data as Record<string, unknown>) } : {}),
  };
}

export function errResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
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
      return errResult(err instanceof Error ? err.message : String(err));
    }
  };
}
