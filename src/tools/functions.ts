import * as zlib from "node:zlib";
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { resolveProject } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";
import { platformUrl } from "../lib/api.js";

// Lizard Functions (AWS Lambda-compatible): the same contract as `lizard fn deploy --json`.
// Files come as text; the service infers packages from imports (or a requirements.txt /
// package.json in the files, or `packages`), builds TypeScript / Go / Rust, and only lets the
// new code take traffic once it has started. A failed deploy returns `code`, `remediation`
// (a corrected call) and the log tail, while the previous version keeps serving.

const REGION_ALIASES: Record<string, string> = { us: "us-east-1", eu: "eu-west-lim-a" };
const RUNTIMES: Record<string, string> = { python: "python3.13", node: "nodejs22.x", typescript: "nodejs22.x", ruby: "ruby3.3", go: "provided.al2023", rust: "provided.al2023" };

interface Account { accountId: string; region: string }

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files: { path: string; content: string }[]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.path.replace(/^\/+/, "")), data = Buffer.from(f.content), comp = zlib.deflateRawSync(data), crc = crc32(data);
    const mode = f.path === "bootstrap" ? 0o100755 : 0o100644;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((mode << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** Language and handler from the files (same rules as the CLI). */
function detect(files: { path: string; content: string }[], language?: string, handler?: string): { runtime: string; handler: string } {
  const names = files.map((f) => f.path);
  const entry = ["handler.py", "lambda_function.py", "app.py", "main.py", "index.ts", "index.mjs", "index.js", "handler.mjs", "handler.js", "lambda_function.rb", "handler.rb", "main.go", "src/main.rs", "bootstrap"].find((n) => names.includes(n))
    ?? names.find((n) => /\.(py|m?js|cjs|ts|rb|go)$/.test(n) && !n.includes("/")) ?? names[0];
  const lang = language ?? (names.includes("Cargo.toml") ? "rust" : names.includes("go.mod") || entry.endsWith(".go") ? "go" : entry.endsWith(".py") ? "python"
    : entry.endsWith(".ts") ? "typescript" : /\.(m?js|cjs)$/.test(entry) ? "node" : entry.endsWith(".rb") ? "ruby" : "python");
  if (handler) return { runtime: RUNTIMES[lang] ?? lang, handler };
  if (lang === "go" || lang === "rust" || entry === "bootstrap") return { runtime: RUNTIMES[lang] ?? "provided.al2023", handler: "bootstrap" };
  const text = files.find((f) => f.path === entry)?.content ?? "";
  const mod = entry.replace(/\.(py|m?js|cjs|ts|rb)$/, "");
  let fn = "handler";
  if (lang === "python") { const n = [...text.matchAll(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(\s*\w+\s*,\s*\w+\s*\)/gm)].map((m) => m[1]); fn = ["lambda_handler", "handler", "main"].find((x) => n.includes(x)) ?? n[0] ?? "handler"; }
  else if (lang === "node" || lang === "typescript") { const n = [...text.matchAll(/export\s+(?:const|let|var|async\s+function|function)\s+([A-Za-z_$][\w$]*)/g), ...text.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]); fn = ["handler", "main"].find((x) => n.includes(x)) ?? n[0] ?? "handler"; }
  else if (lang === "ruby") { const n = [...text.matchAll(/^def\s+([a-z_]\w*)/gm)].map((m) => m[1]); fn = ["lambda_handler", "handler"].find((x) => n.includes(x)) ?? n[0] ?? "handler"; }
  return { runtime: RUNTIMES[lang] ?? "python3.13", handler: `${mod}.${fn}` };
}

export function registerFunctionsTools(server: McpServer, ctx: ToolContext) {
  async function regionOf(flag?: string): Promise<string> {
    const r = await ctx.api.get<any>("/api/functions/regions").catch(() => null);
    const all: string[] = (Array.isArray(r) ? r : r?.regions ?? []).map((x: any) => (typeof x === "string" ? x : x.region ?? x.id)).filter((x: string) => x && !x.startsWith("canary"));
    if (!flag) return all.includes("us-east-1") ? "us-east-1" : all[0] ?? "us-east-1";
    return REGION_ALIASES[flag] ?? flag;
  }
  async function accounts(projectId: string): Promise<Account[]> {
    return ctx.api.get<Account[]>(`/api/functions/accounts?projectId=${encodeURIComponent(projectId)}`);
  }
  async function account(projectId: string, region: string, create: boolean): Promise<Account> {
    const a = (await accounts(projectId)).find((x) => x.region === region);
    if (a) return a;
    if (!create) throw new Error(`No functions in ${region} for this project`);
    return ctx.api.post<Account>("/api/functions/accounts", { projectId, region, withKey: false });
  }
  /** One AWS-API call as the account, through the platform (no AWS keys). */
  async function aws(a: Account, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, target?: string) {
    const h: Record<string, string> = { authorization: `Bearer ${ctx.accessToken}`, "user-agent": "lizard-mcp/0.1.0", ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (target) h["x-lizard-target"] = target;
    const res = await fetch(`${platformUrl()}/api/functions/accounts/${a.accountId}/aws/${path.replace(/^\//, "")}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(900_000) });
    const text = await res.text();
    let data: any; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error((data && (data.message || data.Message || data.error)) || `${res.status} ${res.statusText}`);
    return { data, headers: res.headers };
  }
  async function holding(projectId: string, name: string, region?: string): Promise<Account> {
    const all = await accounts(projectId);
    if (region) { const r = await regionOf(region); const a = all.find((x) => x.region === r); if (!a) throw new Error(`No functions in ${r} for this project`); return a; }
    const found: Account[] = [];
    for (const a of all) { try { await aws(a, "GET", `2015-03-31/functions/${encodeURIComponent(name)}`); found.push(a); } catch { /* not there */ } }
    if (!found.length) throw new Error(`Function ${name} not found (functions_list)`);
    if (found.length > 1) throw new Error(`${name} exists in ${found.map((a) => a.region).join(" and ")}: pass region`);
    return found[0];
  }

  server.registerTool(
    "functions_deploy",
    {
      title: "Deploy a function",
      description:
        "Use this to create or update a Lizard Function (AWS Lambda-compatible: an API endpoint, webhook, scheduled job or anything called on demand) from source files, in one call. " +
        "Pass the files as text (e.g. handler.py with `def handler(event, context)`, index.ts with `export const handler = async (event) => ...`, main.go, src/main.rs + Cargo.toml). " +
        "Packages are installed for you: a requirements.txt / package.json in the files, else `packages`, else what the imports need (bs4 -> beautifulsoup4). " +
        "Returns status 'ready' once the new code has started (a failed update leaves the previous version serving and returns `code`, `remediation` and `logTail`: apply the remediation and call again). " +
        "Idempotent by name: unchanged files are a no-op. HTTP-style handlers get a public URL by default.",
      inputSchema: {
        project: z.string().min(1).describe("project name or id"),
        name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe("function name"),
        files: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1).max(200).describe("source files (text), paths relative to the function root"),
        language: z.enum(["python", "node", "typescript", "ruby", "go", "rust"]).optional(),
        handler: z.string().optional().describe("module.function (default: found in the source)"),
        packages: z.array(z.string()).optional().describe("libraries to preinstall, e.g. ['requests', 'numpy==2.1.3']; [] removes them; omit to infer from imports"),
        url: z.boolean().optional().describe("give it a public URL (default: on for handlers that read HTTP events)"),
        schedule: z.string().optional().describe("'every hour', 'daily at 09:00', 'weekdays at 9am', '*/5 * * * *', rate(...), cron(...); 'off' removes it"),
        env: z.record(z.string(), z.string()).optional(),
        memory_mb: z.number().int().min(128).max(16384).optional(),
        timeout_seconds: z.number().int().min(1).max(86400).optional(),
        region: z.enum(["us", "eu", "us-east-1", "eu-west-lim-a"]).optional(),
        test_event: z.unknown().optional().describe("if set, the function is invoked with this event after deploying and the result returned"),
      },
      annotations: { title: "Deploy a function", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle(async (args: any) => {
      const proj = await resolveProject(ctx.api, args.project);
      const region = await regionOf(args.region);
      const a = await account(proj.id, region, true);
      const { runtime, handler } = detect(args.files, args.language, args.handler);
      const body: Record<string, unknown> = { ZipFile: zip(args.files).toString("base64"), Runtime: runtime, Handler: handler };
      if (args.packages) body.Packages = args.packages;
      if (args.url !== undefined) body.Url = args.url;
      if (args.schedule !== undefined) body.Schedule = /^(off|none)$/i.test(args.schedule) ? "" : args.schedule;
      if (args.env) body.Environment = { Variables: args.env };
      if (args.memory_mb) body.MemorySize = args.memory_mb;
      if (args.timeout_seconds) body.Timeout = args.timeout_seconds;
      const start = (await aws(a, "POST", `lizard/functions/${encodeURIComponent(args.name)}/deploy`, body)).data;
      let d: any;
      const end = Date.now() + 15 * 60_000;
      for (;;) {
        d = (await aws(a, "GET", `lizard/deploys/${start.deployId}`)).data;
        if (d.status !== "deploying" || Date.now() > end) break;
        await new Promise((r) => setTimeout(r, 700));
      }
      delete d.log; delete d.deployId; delete d.startedAt; delete d.endedAt;
      if (d.status === "failed") {
        const have: string[] = d.packages?.requested ?? args.packages ?? [];
        d.remediation =
          d.code === "IMPORT_ERROR" && d.missing?.length ? `call functions_deploy again with packages: ${JSON.stringify([...new Set([...have, ...d.missing])])}`
          : d.code === "HANDLER_NOT_FOUND" && d.candidates?.length ? `call functions_deploy again with handler: "${d.candidates[0]}"`
          : d.code === "PACKAGES_CONFLICT" ? "drop `packages` (the dependency file in the files lists them)"
          : d.code === "AMBIGUOUS_IMPORT" ? `pass packages naming the one you need (${d.ambiguous?.[0]?.choices ?? ""})`
          : "fix the error in logTail and call functions_deploy again";
        return d;
      }
      if (args.test_event !== undefined) {
        const r = await aws(a, "POST", `2015-03-31/functions/${encodeURIComponent(args.name)}/invocations`, args.test_event ?? {}, { "x-amz-log-type": "Tail" });
        const tail = r.headers.get("x-amz-log-result");
        d.test = { ok: !r.headers.get("x-amz-function-error"), error: r.headers.get("x-amz-function-error") || undefined, result: r.data, logTail: tail ? Buffer.from(tail, "base64").toString("utf8").slice(-3000) : undefined };
      }
      return d;
    }),
  );

  server.registerTool(
    "functions_invoke",
    {
      title: "Call a function",
      description: "Use this to call a Lizard Function with an event and get its result and log. `as_schedule` sends the event its schedule sends.",
      inputSchema: {
        project: z.string().min(1), name: z.string().min(1), event: z.unknown().optional(),
        as_schedule: z.boolean().optional(), region: z.enum(["us", "eu", "us-east-1", "eu-west-lim-a"]).optional(),
      },
      annotations: { title: "Call a function", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ project, name, event, as_schedule, region }: any) => {
      const proj = await resolveProject(ctx.api, project);
      const a = await holding(proj.id, name, region);
      const ev = as_schedule ? { source: "lizard.schedule", "detail-type": "Scheduled Event", detail: {}, time: new Date().toISOString() } : event ?? {};
      const r = await aws(a, "POST", `2015-03-31/functions/${encodeURIComponent(name)}/invocations`, ev, { "x-amz-log-type": "Tail" });
      const err = r.headers.get("x-amz-function-error");
      const tail = r.headers.get("x-amz-log-result");
      return { status: err ? "error" : "ok", error: err || undefined, result: r.data, logs: tail ? Buffer.from(tail, "base64").toString("utf8") : "" };
    }),
  );

  server.registerTool(
    "functions_logs",
    {
      title: "Get function logs",
      description: "Use this to read a Lizard Function's recent log lines (print / console.log output and the START / END / REPORT lines).",
      inputSchema: { project: z.string().min(1), name: z.string().min(1), since_minutes: z.number().int().min(1).max(1440).default(15), region: z.enum(["us", "eu", "us-east-1", "eu-west-lim-a"]).optional() },
      annotations: { title: "Get function logs", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project, name, since_minutes, region }: any) => {
      const proj = await resolveProject(ctx.api, project);
      const a = await holding(proj.id, name, region);
      const r = await aws(a, "POST", "", { logGroupName: `/aws/lambda/${name}`, startTime: Date.now() - since_minutes * 60_000, limit: 500 }, {}, "Logs_20140328.FilterLogEvents").catch(() => ({ data: { events: [] } }));
      return { events: (r.data?.events ?? []).map((e: any) => ({ time: new Date(e.timestamp).toISOString(), message: e.message })) };
    }),
  );

  server.registerTool(
    "functions_list",
    {
      title: "List functions",
      description: "Use this to list a project's Lizard Functions in every region (name, region, runtime, state).",
      inputSchema: { project: z.string().min(1) },
      annotations: { title: "List functions", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async ({ project }: any) => {
      const proj = await resolveProject(ctx.api, project);
      const rows: any[] = [];
      for (const a of await accounts(proj.id)) {
        const r = await aws(a, "GET", "2015-03-31/functions/?MaxItems=200").catch(() => ({ data: { Functions: [] } }));
        for (const f of r.data?.Functions ?? []) rows.push({ name: f.FunctionName, region: a.region, runtime: f.Runtime ?? f.PackageType, state: f.State ?? "Active", lastModified: f.LastModified });
      }
      return { functions: rows };
    }),
  );
}
