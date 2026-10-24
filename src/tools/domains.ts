import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { APIError } from "../lib/api.js";
import { resolveProject, resolveService } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

/** Bare-attach (no hostname) generates a *.onlizard.com subdomain; a supplied
 *  hostname attaches a custom domain instead — same endpoint, two body
 *  shapes. Exported so unit tests can cover the dispatch directly. */
export function buildDomainAttachBody(
  hostname?: string,
  port?: number,
  force?: boolean,
): { hostname: string; port?: number; force?: boolean } | { generate: true } {
  return hostname ? { hostname, port, force } : { generate: true };
}

/** URL-encodes the hostname path segment for the delete endpoint. */
export function buildDomainDeletePath(appId: string, hostname: string): string {
  return `/api/apps/${appId}/domains/${encodeURIComponent(hostname)}`;
}

// Domains bought on Lizard (lizard.build/domains). Mirrors lizard-cli's domain-owned.ts.
export const DNS_TYPES = ["A", "AAAA", "CNAME", "ALIAS", "MX", "TXT", "URL301", "URL", "FRAME"] as const;
type DnsType = (typeof DNS_TYPES)[number];
export interface DnsRecord { name: string; type: DnsType; value: string; ttl: number; priority?: number }
interface OwnedDomain { id: string; domain: string; status: string; appId: string | null; expiresAt: number | null }

const WRITE_HINT =
  "Changing a domain bought on Lizard needs a signed-in user: an API key can read its records but not change them. Connect this MCP server with OAuth (sign in to Lizard) instead of a liz_ key.";

function writeError(err: unknown): never {
  if (err instanceof APIError && err.status === 401) throw new Error(WRITE_HINT);
  throw err;
}

const POINTING: DnsType[] = ["A", "AAAA", "CNAME", "ALIAS", "URL301", "URL", "FRAME"];
/** Records that pointing `names` at a service would replace, leaving out the registrar's
 *  parking page and an earlier Lizard target. Same rule as lizard-cli's recordsToReplace. */
export function recordsToReplace(records: DnsRecord[], names: string[]): DnsRecord[] {
  return records.filter((r) => names.includes(r.name) && POINTING.includes(r.type)
    && !/(^|\.)parkingpage\.namecheap\.com\.?$/i.test(r.value) && !/(^|\.)onlizard\.com\.?$/i.test(r.value)
    && !(r.type === "URL" && /^https?:\/\/www\.[^/?]+\/?(\?from=@)?$/i.test(r.value)));
}

/** "@", "api", or "api.example.com" -> the name relative to the domain. */
export function relativeName(name: string, domain: string): string {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (n === "@" || n === domain) return "@";
  if (n.endsWith(`.${domain}`)) return n.slice(0, -(domain.length + 1));
  return n;
}

/** The records after one change: set replaces that name and type, add keeps the others, remove drops matches. */
export function applyDnsChange(
  records: DnsRecord[],
  change: { action: "set" | "add" | "remove"; name: string; type?: DnsType; value?: string; ttl?: number; priority?: number },
): { records: DnsRecord[]; removed: DnsRecord[] } {
  if (change.action === "remove") {
    const match = (r: DnsRecord) => r.name === change.name && (!change.type || r.type === change.type) && (change.value === undefined || r.value === change.value);
    const removed = records.filter(match);
    if (!removed.length) throw new Error(`No record matches ${[change.name, change.type, change.value].filter(Boolean).join(" ")}.`);
    return { records: records.filter((r) => !match(r)), removed };
  }
  if (!change.type || change.value === undefined) throw new Error(`${change.action} needs type and value.`);
  const rec: DnsRecord = { name: change.name, type: change.type, value: change.value, ttl: change.ttl ?? 1800 };
  if (change.type === "MX") rec.priority = change.priority ?? 10;
  const kept = change.action === "set" ? records.filter((r) => !(r.name === change.name && r.type === change.type)) : records;
  return { records: [...kept, rec], removed: change.action === "set" ? records.filter((r) => !kept.includes(r)) : [] };
}

async function listOwned(ctx: ToolContext): Promise<OwnedDomain[]> {
  const r = await ctx.api.get<{ orders?: OwnedDomain[] }>("/api/domains/orders");
  return r.orders ?? [];
}

/** The registered bought domain that `hostname` is, or is under; null when none (or the token can't see them). */
async function ownedFor(ctx: ToolContext, hostname: string): Promise<OwnedDomain | null> {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const orders = await listOwned(ctx).catch(() => []);
  return orders
    .filter((o) => o.status === "registered" && (host === o.domain || host.endsWith(`.${o.domain}`)))
    .sort((a, b) => b.domain.length - a.domain.length)[0] ?? null;
}

async function ownedByName(ctx: ToolContext, domain: string): Promise<OwnedDomain> {
  const d = domain.toLowerCase().replace(/\.$/, "");
  const all = await listOwned(ctx);
  const o = all.find((x) => x.domain === d);
  if (!o) {
    const names = all.filter((x) => x.status === "registered").map((x) => x.domain);
    throw new Error(`${d} is not a domain bought on Lizard.${names.length ? ` Yours: ${names.join(", ")}.` : " Buy one at https://lizard.build/domains."}`);
  }
  if (o.status !== "registered") throw new Error(`${d} is not registered yet (status: ${o.status}).`);
  return o;
}

const dnsPath = (order: OwnedDomain) => `/api/domains/orders/${encodeURIComponent(order.id)}/dns`;

export function registerDomainTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "domain_attach",
    {
      title: "Attach domain",
      description:
        "Every app already gets a *.onlizard.com domain automatically on its first deploy (check service_show's `domain` field before calling this — do not invent or guess a hostname). Only call this tool when the user explicitly wants to attach their own custom domain (pass hostname), or when service_show shows no domain yet (e.g. the service was created with skipInitialDeploy and never deployed) and they want one generated. Calling this again without hostname generates another subdomain rather than returning the existing one. " +
        "For a domain bought on Lizard (domain_owned_list) or a subdomain of it, the DNS records are set for you; if that would replace records that point elsewhere, the call refuses and lists them, and force: true replaces them. Otherwise the response lists the DNS records the user must add, then domain_verify.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1),
        hostname: z.string().optional().describe("Custom hostname to attach; omit to generate a default subdomain"),
        port: z.number().int().optional(),
        force: z.boolean().optional().describe("Move the domain here if it's attached to another of your services; on a bought domain, also replace records that point elsewhere"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project, service, hostname, port, force }) => {
      const proj = await resolveProject(ctx.api, project);
      const svc = await resolveService(ctx.api, proj.id, service, { workspaceId: proj.workspaceId });
      const order = hostname ? await ownedFor(ctx, hostname) : null;
      if (hostname && order) {
        if (svc.kind !== "app") throw new Error(`"${service}" is a database; domains attach to apps.`);
        const host = hostname.toLowerCase().replace(/\.$/, "");
        const names = host === order.domain ? ["@", "www"] : [host.slice(0, -(order.domain.length + 1))];
        if (!force) {
          const dns = await ctx.api.get<{ records: DnsRecord[] }>(dnsPath(order));
          const replaced = recordsToReplace(dns.records, names);
          if (replaced.length) {
            throw new Error(
              `This replaces records on ${order.domain}: ${replaced.map((r) => `${r.name} ${r.type} ${r.value}`).join(", ")}. ` +
                "Ask the user, then call again with force: true to replace them.",
            );
          }
        }
        const r = await ctx.api
          .post(`/api/domains/orders/${encodeURIComponent(order.id)}/connect`, { appId: svc.id, hostname: host, force: !!force })
          .catch(writeError);
        return { ...(r as object), domain: order.domain, hostname: host, boughtOnLizard: true };
      }
      return ctx.api.post(`/api/apps/${svc.id}/domains`, buildDomainAttachBody(hostname, port, force));
    }),
  );

  server.registerTool(
    "domain_verify",
    {
      title: "Verify domain DNS",
      description: "Use this when the user wants to verify DNS configuration for a custom domain attached to a Lizard service.",
      inputSchema: { project: z.string().min(1), service: z.string().min(1), hostname: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, service, hostname }) => {
      const proj = await resolveProject(ctx.api, project);
      const svc = await resolveService(ctx.api, proj.id, service, { workspaceId: proj.workspaceId });
      return ctx.api.post(`/api/apps/${svc.id}/domains/verify`, { hostname });
    }),
  );

  server.registerTool(
    "domain_delete",
    {
      title: "Delete domain",
      description:
        "Use this when the user wants to remove a custom domain from a Lizard service. This is destructive and requires explicit confirmation.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1),
        hostname: z.string(),
        confirm: z.literal(true).describe("Must be true to proceed; there is no interactive confirmation in MCP"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project, service, hostname }) => {
      const proj = await resolveProject(ctx.api, project);
      const svc = await resolveService(ctx.api, proj.id, service, { workspaceId: proj.workspaceId });
      await ctx.api.delete(buildDomainDeletePath(svc.id, hostname));
      return { hostname, status: "deleted" };
    }),
  );

  server.registerTool(
    "domain_owned_list",
    {
      title: "List bought domains",
      description:
        "List the domains the user bought on Lizard (lizard.build/domains): domain, status (registered once ready), expiry and whether one points at an app. Needs a signed-in user or an API key with no scopes.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async () => ({ domains: await listOwned(ctx) })),
  );

  server.registerTool(
    "domain_dns_list",
    {
      title: "List DNS records",
      description: "Read the DNS records of a domain bought on Lizard: name (@ for the domain itself), type, value, TTL and MX priority.",
      inputSchema: { domain: z.string().min(1).describe("A domain from domain_owned_list, e.g. example.com") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ domain }) => ctx.api.get(dnsPath(await ownedByName(ctx, domain)))),
  );

  server.registerTool(
    "domain_dns_update",
    {
      title: "Change a DNS record",
      description:
        "Change one DNS record of a domain bought on Lizard. set replaces every record with that name and type; add keeps the others (several MX or TXT); remove deletes the records that match name, and type and value when given. " +
        "Types: A, AAAA, CNAME, ALIAS, MX, TXT, URL301 (redirect), URL (302 redirect), FRAME (masked redirect). To point a name at a Lizard app, use domain_attach instead. " +
        "Needs a signed-in user: an API key can read records but not change them. Changes reach most resolvers within minutes. Get the user's approval before remove.",
      inputSchema: {
        domain: z.string().min(1).describe("A domain from domain_owned_list"),
        action: z.enum(["set", "add", "remove"]),
        name: z.string().min(1).describe("@ for the domain itself, a label like api, or a full name like api.example.com"),
        type: z.enum(DNS_TYPES).optional().describe("Required for set and add"),
        value: z.string().optional().describe("Required for set and add"),
        ttl: z.number().int().min(60).max(86400).optional().describe("Seconds, default 1800"),
        priority: z.number().int().min(0).max(65535).optional().describe("MX only, default 10"),
        confirm: z.literal(true).optional().describe("Required for remove"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handle(async ({ domain, action, name, type, value, ttl, priority, confirm }) => {
      if (action === "remove" && confirm !== true) throw new Error("remove needs confirm: true after the user approves it.");
      const order = await ownedByName(ctx, domain);
      const current = await ctx.api.get<{ records: DnsRecord[]; version: string }>(dnsPath(order));
      const next = applyDnsChange(current.records, { action, name: relativeName(name, order.domain), type, value, ttl, priority });
      const saved = await ctx.api.put(dnsPath(order), { version: current.version, records: next.records }).catch(writeError);
      return { domain: order.domain, ...(saved as object), ...(next.removed.length ? { removed: next.removed } : {}) };
    }),
  );
}
