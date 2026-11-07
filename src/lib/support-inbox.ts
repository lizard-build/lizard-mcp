import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApiClient } from "./api.js";

// Support replies for agents that use Lizard through MCP: while a ticket has a reply the caller
// has not read, a short notice is added to the end of other tool results (each reply at most
// twice, checked at most once a minute per caller). support_show prints the thread and marks it read.
//
// The server builds a fresh McpServer per request, so the state lives here, per process, keyed
// by a hash of the access token. Losing it (restart, another region) only means a notice may show
// once more.

interface UnreadTicket { ticket: string; subject: string; messages: Array<{ from: string; body: string; at: string }> }
interface CallerState { checkedAt: number; shown: Map<string, number> }

const CHECK_EVERY_MS = 60_000;
const SHOW_TIMES = 2;
const MAX_CALLERS = 5000;
const callers = new Map<string, CallerState>();

function keyOf(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

export function resetSupportInbox(): void { callers.clear(); }

/** The notice text, or null. Never throws, never waits more than 1.5 s. */
export async function supportNotice(api: ApiClient, accessToken: string, now = Date.now()): Promise<string | null> {
  if (!accessToken) return null;
  const key = keyOf(accessToken);
  let st = callers.get(key);
  if (st && now - st.checkedAt < CHECK_EVERY_MS) return null;
  if (!st) {
    if (callers.size >= MAX_CALLERS) callers.delete(callers.keys().next().value as string);
    st = { checkedAt: now, shown: new Map() };
    callers.set(key, st);
  }
  st.checkedAt = now;
  try {
    const res = await Promise.race([
      api.get<{ tickets: UnreadTicket[] }>("/api/support/unread"),
      new Promise<null>((r) => setTimeout(() => r(null), 1500).unref()),
    ]);
    if (!res?.tickets?.length) return null;
    const out: string[] = [];
    for (const t of res.tickets) {
      const fresh = t.messages.filter((m) => (st.shown.get(`${t.ticket}@${m.at}`) ?? 0) < SHOW_TIMES);
      if (!fresh.length) continue;
      out.push(`📬 Lizard support replied on ${t.ticket} (${t.subject}):`);
      for (const m of fresh) {
        st.shown.set(`${t.ticket}@${m.at}`, (st.shown.get(`${t.ticket}@${m.at}`) ?? 0) + 1);
        out.push(`${m.from}: ${m.body}`);
      }
      out.push(`Answer with support_reply (ticket "${t.ticket}"); support_show shows the whole thread. Tell the user what support said.`);
    }
    return out.length ? out.join("\n") : null;
  } catch {
    return null;
  }
}

/** Adds the notice as one more text block; structuredContent stays as it was. */
export function withNotice(result: CallToolResult, notice: string | null): CallToolResult {
  if (!notice) return result;
  return { ...result, content: [...(result.content ?? []), { type: "text", text: notice }] };
}
