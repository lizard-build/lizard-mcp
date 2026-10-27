import { posix } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { APIError, apiErrorFrom, NO_TOKEN_MESSAGE, withQuery } from "../lib/api.js";
import { resolveProject } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

const MAX_TEXT_BYTES = 65536;
const MIN_LIFETIME_MS = 60_000;
/** A day: long enough for an agent's working session, short enough that a forgotten sandbox stops. */
const MAX_LIFETIME_MS = 86_400_000;
/** Matches lizard-cli's MAX_FORK_COUNT. */
const MAX_FORK_COUNT = 100;
/** Where sandbox_create starts a sandbox that names no region, volume or snapshot. Matches lizard-cli. */
const DEFAULT_SANDBOX_REGION = "us-east-1";
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).describe("Exact sandbox ID from sandbox_create or sandbox_list");
const snapshotId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).describe("Snapshot ID from sandbox_snapshot or sandbox_snapshot_list");
const path = z.string().min(1).refine(value => !value.includes("\0"), "Path must not contain NUL bytes");
const lifetime = z.number().int().min(MIN_LIFETIME_MS).max(MAX_LIFETIME_MS);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const change = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

async function request<T>(ctx: ToolContext, route: string, method = "GET", body?: unknown, signal?: AbortSignal, text = false): Promise<T> {
  if (!ctx.accessToken) throw new Error(NO_TOKEN_MESSAGE);
  const base = process.env.PLATFORM_URL || "https://lizard.build";
  const response = await fetch(base + route, {
    method, signal,
    headers: { Authorization: `Bearer ${ctx.accessToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail: unknown = await response.json().catch(() => null);
    throw apiErrorFrom(response.status, response.statusText, detail);
  }
  if (text) return await response.text() as T;
  const value = await response.text();
  return (value ? JSON.parse(value) : undefined) as T;
}

function route(sandboxId: string) {
  return `/api/sandboxes/${encodeURIComponent(sandboxId)}`;
}

async function destroy(ctx: ToolContext, sandboxId: string) {
  try { await request(ctx, route(sandboxId), "DELETE", undefined, AbortSignal.timeout(30000)); return true; }
  catch (error) { if (error instanceof APIError && error.status === 404) return false; throw error; }
}

function clip(text: string) {
  const bytes = Buffer.from(text);
  return {
    text: bytes.length > MAX_TEXT_BYTES ? new TextDecoder().decode(bytes.subarray(0, MAX_TEXT_BYTES), { stream: true }) : text,
    truncated: bytes.length > MAX_TEXT_BYTES,
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Poll until `done` says yes or `waitMs` runs out; returns the last value either way. */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, waitMs: number, fail?: (value: T) => string | null): Promise<T> {
  const until = Date.now() + waitMs;
  let value = await read();
  while (!done(value) && Date.now() < until) {
    const reason = fail?.(value);
    if (reason) throw new Error(reason);
    await sleep(1000);
    value = await read();
  }
  return value;
}

/** A volume name or an id: ids are what the platform generates (`fcv-…` or a 21-character nanoid). */
export function volumeRef(volume: string): { volumeId: string } | { volumeName: string } {
  return /^fcv-/.test(volume) || /^[A-Za-z0-9_-]{21}$/.test(volume) ? { volumeId: volume } : { volumeName: volume };
}

export async function execInSandbox(ctx: ToolContext, sandboxId: string, command: string, cwd: string, timeoutMs: number, signal: AbortSignal, envs?: Record<string, string>) {
  signal.throwIfAborted();
  if (!ctx.accessToken) throw new Error(NO_TOKEN_MESSAGE);
  try {
    const result = await request<{ stdout: string; stderr: string; exitCode: number; truncated?: boolean }>(ctx, `${route(sandboxId)}/exec`, "POST", {
      cmd: command, workdir: cwd, timeoutMs, ...(envs && Object.keys(envs).length ? { envs } : {}),
    }, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
    const stdout = clip(result.stdout);
    const stderr = clip(result.stderr);
    return { sandboxId, exitCode: result.exitCode, stdout: stdout.text, stderr: stderr.text, truncated: !!result.truncated || stdout.truncated || stderr.truncated };
  } catch (error) {
    // These responses reject the command before it starts; no cleanup is needed.
    if (error instanceof APIError && [400, 401, 402, 403, 404, 409, 429].includes(error.status)) throw error;
    try { await destroy(ctx, sandboxId); }
    catch { throw new Error("Command outcome is unknown and sandbox cleanup failed. Do not repeat the command. Inspect sandbox_show and retry sandbox_delete."); }
    throw new Error(`${error instanceof Error ? error.message : "Command failed"} The sandbox and its files were destroyed.`);
  }
}

interface SandboxRecord { id?: string; sandboxId?: string; status?: string; [key: string]: unknown }
interface SnapshotRecord { id: string; status: string; error?: string; [key: string]: unknown }

export function registerSandboxTools(server: McpServer, ctx: ToolContext) {
  server.registerTool("sandbox_list", {
    title: "List sandboxes",
    description: "List Lizard Sandboxes in an explicit project. Use the returned IDs with sandbox tools; these resources are separate from app services.",
    inputSchema: { project: z.string().min(1) }, annotations: { title: "List sandboxes", ...readOnly },
  }, handle(async ({ project }) => {
    const resolved = await resolveProject(ctx.api, project);
    return ctx.api.get(`/api/projects/${encodeURIComponent(resolved.id)}/sandboxes`);
  }));

  server.registerTool("sandbox_show", {
    title: "Show sandbox",
    description: "Read a sandbox's status (running, pausing, paused, resuming, ...), project, template, size and expiry. The platform checks the current user's access to this ID.",
    inputSchema: { sandboxId: id }, annotations: { title: "Show sandbox", ...readOnly },
  }, handle(async ({ sandboxId }) => {
    return ctx.api.get(route(sandboxId));
  }));

  server.registerTool("sandbox_create", {
    title: "Create sandbox",
    description:
      "Create a sandbox (a Firecracker microVM) in an explicit project. Uses billed cloud resources and returns its ID. " +
      "Defaults: template interpreter, size small (2 vCPU / 4 GB), a 5-minute lifetime; expiry deletes its files unless a volume is attached. " +
      "Other templates: base, codex, claude, opencode, pi, prime, desktop (the server checks the name). Sizes: small, medium (4 vCPU / 8 GB), large (8 vCPU / 16 GB). " +
      "Pass snapshotId to start from a saved snapshot (it keeps the snapshot's size, so leave size out) and volume to mount a persistent volume. " +
      "No host files, environment variables, or API key are copied into it. Get the user's approval before creating it; do not retry an uncertain response blindly.",
    inputSchema: {
      project: z.string().min(1),
      lifetimeMs: lifetime.default(300000).describe("Lifetime in ms, 60,000 to 86,400,000 (a day); extend later with sandbox_set_timeout"),
      template: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional().describe("Template name; default interpreter"),
      size: z.enum(["small", "medium", "large"]).optional().describe("Default small; not with snapshotId"),
      region: z.string().min(1).optional().describe(`Region code (region_list); default ${DEFAULT_SANDBOX_REGION}, or the volume's or snapshot's region`),
      volume: z.string().min(1).optional().describe("Persistent volume name or ID in the same project (volume_list)"),
      snapshotId: snapshotId.optional(),
      confirm: z.literal(true),
    }, annotations: { title: "Create sandbox", ...write, openWorldHint: false },
  }, handle(async ({ project, lifetimeMs, template, size, region, volume, snapshotId: fromSnapshot }, extra) => {
    if (fromSnapshot && size) throw new Error("size can't be combined with snapshotId: a snapshot starts at the size it was taken at.");
    extra.signal.throwIfAborted();
    const resolved = await resolveProject(ctx.api, project);
    extra.signal.throwIfAborted();
    // No region: us-east-1. A volume or a snapshot exists in one region only, so with either
    // the server places the sandbox there instead.
    const defaultRegion = !region && !volume && !fromSnapshot;
    const body = (sendRegion: string | undefined) => fromSnapshot
      ? { snapshotId: fromSnapshot, projectId: resolved.id, timeoutMs: lifetimeMs, region, ...(volume ? volumeRef(volume) : {}), metadata: { integration: "lizard-mcp" } }
      : {
          template: template ?? "interpreter", projectId: resolved.id, size: size ?? "small", timeoutMs: lifetimeMs,
          ...(sendRegion ? { region: sendRegion } : {}), ...(volume ? volumeRef(volume) : {}), metadata: { integration: "lizard-mcp" },
        };
    let sandbox: SandboxRecord;
    try {
      sandbox = await ctx.api.post<SandboxRecord>("/api/sandboxes", body(region ?? (defaultRegion ? DEFAULT_SANDBOX_REGION : undefined)));
    } catch (error) {
      // New sandboxes paused in the default region: ask again without one, and the platform
      // picks an open region. A region the caller named is never swapped for another.
      if (!defaultRegion || !(error instanceof APIError) || error.code !== "region_unavailable") throw error;
      extra.signal.throwIfAborted();
      sandbox = await ctx.api.post<SandboxRecord>("/api/sandboxes", body(undefined));
    }
    const sandboxId = sandbox.sandboxId ?? sandbox.id!;
    if (extra.signal.aborted) {
      await destroy(ctx, sandboxId);
      extra.signal.throwIfAborted();
    }
    return {
      ...sandbox, sandboxId, projectId: resolved.id, template: sandbox.template ?? (fromSnapshot ? undefined : template ?? "interpreter"),
      workdir: "/workspace", lifetimeMs,
    };
  }));

  server.registerTool("sandbox_exec", {
    title: "Run sandbox command",
    description: "Run a shell command inside an existing sandbox, as root. Requires the user's approval. Cancellation, timeout, or a failed command request destroys the whole sandbox and all its files to stop remote code. A nonzero command exit code preserves it. Use an ephemeral sandbox created for this task. Output is capped at 64 KiB per stream; do not blindly retry a failed command.",
    inputSchema: {
      sandboxId: id, command: z.string().trim().min(1), cwd: path.default("/workspace"),
      timeoutMs: z.number().int().min(1000).max(120000).default(60000),
      envs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional().describe("Environment variables for this command only"),
      confirm: z.literal(true).describe("User approved the command and loss of sandbox files if cancellation, timeout, or request failure requires cleanup"),
    }, annotations: { title: "Run sandbox command", ...write },
  }, handle(async ({ sandboxId, command, cwd, timeoutMs, envs }, extra) => {
    extra.signal.throwIfAborted();
    return execInSandbox(ctx, sandboxId, command, posix.resolve("/workspace", cwd), timeoutMs, extra.signal, envs);
  }));

  server.registerTool("sandbox_read_file", {
    title: "Read sandbox text file",
    description: "Read up to 64 KiB of UTF-8 text from a sandbox. Relative paths start at /workspace. Paths refer to the remote sandbox, never the MCP server's files. Uses the Lizard API; docs: https://lizard.build/docs/.",
    inputSchema: { sandboxId: id, path }, annotations: { title: "Read sandbox text file", ...readOnly },
  }, handle(async ({ sandboxId, path: file }) => {
    const resolved = posix.resolve("/workspace", file);
    const query = new URLSearchParams({ path: resolved });
    const info = await ctx.api.get<{ size: number }>(`${route(sandboxId)}/files/stat?${query}`);
    if (info.size > MAX_TEXT_BYTES) throw new Error("File exceeds 64 KiB; use a sandbox command to read a smaller part.");
    const content = await request<string>(ctx, `${route(sandboxId)}/files?${query}`, "GET", undefined, AbortSignal.timeout(30000), true);
    if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new Error("File exceeds 64 KiB.");
    return { sandboxId, path: resolved, content };
  }));

  server.registerTool("sandbox_write_file", {
    title: "Write sandbox text file",
    description: "Write up to 64 KiB of UTF-8 text to a sandbox, replacing an existing file. Requires the user's approval. Relative paths start at /workspace. Does not write to the MCP server's filesystem. Uses the Lizard API; docs: https://lizard.build/docs/.",
    inputSchema: {
      sandboxId: id, path,
      content: z.string().refine(value => Buffer.byteLength(value) <= MAX_TEXT_BYTES, "Content exceeds 64 KiB"),
      confirm: z.literal(true),
    }, annotations: { title: "Write sandbox text file", ...write, idempotentHint: true, openWorldHint: false },
  }, handle(async ({ sandboxId, path: file, content }, extra) => {
    extra.signal.throwIfAborted();
    const resolved = posix.resolve("/workspace", file);
    await ctx.api.post(`${route(sandboxId)}/files`, { path: resolved, content });
    return { sandboxId, path: resolved, bytes: Buffer.byteLength(content) };
  }));

  server.registerTool("sandbox_list_files", {
    title: "List sandbox files",
    description: "List one directory inside a sandbox: name, path, type and size of each entry. Relative paths start at /workspace. Uses the Lizard API; docs: https://lizard.build/docs/.",
    inputSchema: { sandboxId: id, path: path.default("/workspace") }, annotations: { title: "List sandbox files", ...readOnly },
  }, handle(async ({ sandboxId, path: dir }) => {
    const resolved = posix.resolve("/workspace", dir);
    const entries = await ctx.api.get(withQuery(`${route(sandboxId)}/files/list`, { path: resolved }));
    return { sandboxId, path: resolved, entries };
  }));

  server.registerTool("sandbox_delete", {
    title: "Delete sandbox",
    description: "Permanently destroy one sandbox and all its files (an attached volume stays). Get the user's approval before calling. Use this to clean up a sandbox created for a task. Does not delete its project or any app services.",
    inputSchema: { sandboxId: id, confirm: z.literal(true) },
    annotations: { title: "Delete sandbox", ...write, idempotentHint: true, openWorldHint: false },
  }, handle(async ({ sandboxId }, extra) => {
    extra.signal.throwIfAborted();
    return { sandboxId, deleted: await destroy(ctx, sandboxId) };
  }));

  server.registerTool("sandbox_set_timeout", {
    title: "Set sandbox lifetime",
    description: "Change how long a sandbox lives from now: it stops and loses its files (except an attached volume) when the time runs out. Use it to keep a sandbox the user still needs, or to end one sooner. 60,000 ms to 86,400,000 ms (a day).",
    inputSchema: { sandboxId: id, lifetimeMs: lifetime },
    annotations: { title: "Set sandbox lifetime", ...change, idempotentHint: true },
  }, handle(async ({ sandboxId, lifetimeMs }) => ctx.api.post(`${route(sandboxId)}/timeout`, { timeoutMs: lifetimeMs })));

  for (const op of ["pause", "resume"] as const) {
    server.registerTool(`sandbox_${op}`, {
      title: op === "pause" ? "Pause sandbox" : "Resume sandbox",
      description: op === "pause"
        ? "Save a running sandbox's memory, processes and files, and stop it. A paused sandbox costs only its storage and does not count against the running-sandbox limit. Waits up to 2 minutes for it to finish pausing. Undo with sandbox_resume."
        : "Start a paused sandbox again, where it left off: same memory, processes and files. Waits up to 2 minutes for it to run. If resuming fails, the saved state is kept; try again.",
      inputSchema: { sandboxId: id },
      annotations: { title: op === "pause" ? "Pause sandbox" : "Resume sandbox", ...change, idempotentHint: true },
    }, handle(async ({ sandboxId }) => {
      const queued = await ctx.api.post<{ status?: string }>(`${route(sandboxId)}/${op}`, {});
      const target = op === "pause" ? "paused" : "running";
      const final = await waitFor(
        () => ctx.api.get<{ id: string; status: string }>(route(sandboxId)),
        (s) => s.status === target,
        120_000,
        (s) => (["running", "pausing", "paused", "resuming"].includes(s.status) ? null : `Sandbox ${sandboxId} is ${s.status}.`),
      );
      return { sandboxId, status: final.status, ...(final.status !== target ? { note: `Still ${final.status}; check again with sandbox_show.` } : {}), queued };
    }));
  }

  server.registerTool("sandbox_snapshot", {
    title: "Snapshot sandbox",
    description:
      "Save a running sandbox, memory and processes included, as a private snapshot to start new sandboxes from (sandbox_create with snapshotId). " +
      "The sandbox keeps running. scope says where it may be restored: user (any of your projects), workspace, or project. Snapshots are billed for storage until deleted. " +
      "Waits up to 2 minutes for the snapshot to be ready; a large one may still be processing, so check sandbox_snapshot_list.",
    inputSchema: {
      sandboxId: id,
      name: z.string().min(1).max(100).describe("A name for the snapshot"),
      scope: z.enum(["user", "workspace", "project"]).optional(),
    },
    annotations: { title: "Snapshot sandbox", ...change },
  }, handle(async ({ sandboxId, name, scope }) => {
    const started = await ctx.api.post<SnapshotRecord>(`${route(sandboxId)}/snapshot`, { name, ...(scope ? { scope } : {}) });
    return waitFor(
      () => ctx.api.get<SnapshotRecord>(`/api/sandbox-snapshots/${encodeURIComponent(started.id)}`),
      (s) => s.status === "ready",
      120_000,
      (s) => (s.status === "failed" ? s.error || "Snapshot capture failed" : null),
    );
  }));

  server.registerTool("sandbox_snapshot_list", {
    title: "List sandbox snapshots",
    description: "List the saved sandbox snapshots of a project: ID, name, template, region, size, scope and status.",
    inputSchema: { project: z.string().min(1) }, annotations: { title: "List sandbox snapshots", ...readOnly },
  }, handle(async ({ project }) => {
    const resolved = await resolveProject(ctx.api, project);
    return ctx.api.get(`/api/projects/${encodeURIComponent(resolved.id)}/snapshots`);
  }));

  server.registerTool("sandbox_snapshot_delete", {
    title: "Delete sandbox snapshot",
    description: "Permanently delete a saved sandbox snapshot. Sandboxes already started from it keep running. Get the user's approval first.",
    inputSchema: { snapshotId, confirm: z.literal(true) },
    annotations: { title: "Delete sandbox snapshot", ...write, idempotentHint: true, openWorldHint: false },
  }, handle(async ({ snapshotId: snap }) => {
    await ctx.api.delete(`/api/sandbox-snapshots/${encodeURIComponent(snap)}`);
    return { snapshotId: snap, deleted: true };
  }));

  server.registerTool("sandbox_fork", {
    title: "Fork sandbox",
    description:
      "Start live copies of a running sandbox: memory, processes and files. The source pauses for a moment and keeps running. " +
      "Each copy is a new billed sandbox and counts toward the running-sandbox limits, so near a limit only some may start: " +
      "the result has one entry per copy, a sandbox or an error. Copies live as long as the source unless lifetimeMs is given. Get the user's approval first.",
    inputSchema: {
      sandboxId: id,
      count: z.number().int().min(1).max(MAX_FORK_COUNT).default(1),
      lifetimeMs: lifetime.optional(),
      confirm: z.literal(true),
    },
    annotations: { title: "Fork sandbox", ...change, openWorldHint: false },
  }, handle(async ({ sandboxId, count, lifetimeMs }) => {
    const results = await ctx.api.post<Array<{ sandbox?: SandboxRecord; error?: string }>>(`${route(sandboxId)}/fork`, {
      count, ...(lifetimeMs ? { timeoutMs: lifetimeMs } : {}),
    });
    const list = Array.isArray(results) ? results : [];
    const started = list.filter((r) => r.sandbox).length;
    if (started === 0) throw new Error(`No copy started: ${list.map((r) => r.error).filter(Boolean).join("; ") || "fork failed"}`);
    return { sourceId: sandboxId, requested: count, started, failed: list.length - started, results: list };
  }));

  server.registerTool("sandbox_expose_port", {
    title: "Expose sandbox port",
    description: "Give a port inside a running sandbox an HTTPS URL, e.g. to show the user a web app the sandbox runs (it must listen on 0.0.0.0). The port stays private: the returned url carries an access token, so a browser opens it once and then keeps a cookie; other clients send accessToken in the X-Lizard-Access-Token header. Anyone with the url or token can reach the port, so share it only with the user. Remove it with sandbox_unexpose_port.",
    inputSchema: { sandboxId: id, port: z.number().int().min(1).max(65535) },
    annotations: { title: "Expose sandbox port", ...change, idempotentHint: true, openWorldHint: true },
  }, handle(async ({ sandboxId, port }) => ctx.api.post(`${route(sandboxId)}/expose/${port}`)));

  server.registerTool("sandbox_unexpose_port", {
    title: "Remove sandbox port URL",
    description: "Remove the HTTPS URL of a sandbox port; its access token stops working. The process inside keeps running.",
    inputSchema: { sandboxId: id, port: z.number().int().min(1).max(65535) },
    annotations: { title: "Remove sandbox port URL", ...change, idempotentHint: true },
  }, handle(async ({ sandboxId, port }) => {
    await ctx.api.delete(`${route(sandboxId)}/expose/${port}`);
    return { sandboxId, port, status: "unexposed" };
  }));
}
