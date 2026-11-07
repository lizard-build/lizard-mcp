import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSupportInbox, supportNotice, withNotice } from "../../src/lib/support-inbox.js";

const reply = { tickets: [{ ticket: "T-1043", subject: "eu create 500", messages: [{ from: "Lizard support", body: "Which region?", at: "2026-11-07T18:00:00.000Z" }] }] };
const apiWith = (get: () => Promise<unknown>) => ({ get: vi.fn(get) }) as any;

beforeEach(() => resetSupportInbox());

describe("support notice in MCP results", () => {
  it("shows an unread reply at most twice and checks at most once a minute", async () => {
    const api = apiWith(async () => reply);
    const t0 = 1_000_000;
    const a = await supportNotice(api, "tok", t0);
    expect(a).toContain("Which region?");
    expect(a).toContain("support_reply");
    expect(await supportNotice(api, "tok", t0 + 1000)).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(await supportNotice(api, "tok", t0 + 61_000)).toContain("Which region?");
    expect(await supportNotice(api, "tok", t0 + 122_000)).toBeNull();
  });
  it("keeps callers apart and never throws", async () => {
    expect(await supportNotice(apiWith(async () => { throw new Error("down"); }), "a")).toBeNull();
    expect(await supportNotice(apiWith(async () => reply), "b")).toContain("T-1043");
  });
  it("appends a text block and leaves structuredContent alone", () => {
    const r = withNotice({ content: [{ type: "text", text: "{}" }], structuredContent: { ok: true } }, "📬 x");
    expect(r.content).toHaveLength(2);
    expect(r.structuredContent).toEqual({ ok: true });
    expect(withNotice({ content: [] }, null).content).toHaveLength(0);
  });
});
