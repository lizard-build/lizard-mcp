import { NO_TOKEN_MESSAGE } from "./api.js";

const PLATFORM_URL = process.env.PLATFORM_URL || "https://lizard.build";

export interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Collects Server-Sent Events from a dragonlabs-platform endpoint into an
 * array, then stops — never reconnects, never follows indefinitely. This is
 * deliberately simpler than lizard-cli's `streamSSE` (lib/api.ts), which
 * exists to follow a live log stream forever with reconnect/replay handling;
 * lizard-mcp only ever needs bounded reads (a build finishes, a command
 * exits, or we give up after `idleTimeoutMs` of silence), since an MCP tool
 * call must return.
 */
export async function collectSSE(
  path: string,
  accessToken: string,
  opts: { idleTimeoutMs?: number; stopOn?: (event: string, data: string) => boolean } = {},
): Promise<SSEEvent[]> {
  if (!accessToken) throw new Error(NO_TOKEN_MESSAGE);

  const controller = new AbortController();
  const res = await fetch(PLATFORM_URL + path, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE request failed: HTTP ${res.status}`);
  }

  const events: SSEEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let dataLines: string[] = [];
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const armIdleTimer = () => {
    if (!opts.idleTimeoutMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stopped = true;
      controller.abort();
    }, opts.idleTimeoutMs);
  };
  armIdleTimer();

  try {
    outer: while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (line === "") {
          // Matches lizard-cli's streamSSE: only dispatch (and reset the idle
          // timer) for events with genuinely non-empty data, not merely a
          // present-but-empty `data:` line.
          const data = dataLines.join("\n");
          if (data) {
            events.push({ event: currentEvent, data });
            armIdleTimer();
            if (opts.stopOn?.(currentEvent, data)) {
              stopped = true;
              break outer;
            }
          }
          currentEvent = "";
          dataLines = [];
        } else if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
  } catch (err) {
    // Our own idle-timeout abort surfaces as AbortError — expected, not a failure.
    if (!(err instanceof Error && err.name === "AbortError")) throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    controller.abort();
  }

  return events;
}
