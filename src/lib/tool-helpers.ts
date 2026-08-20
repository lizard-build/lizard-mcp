import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
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
