import { posix } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { APIError, apiErrorFrom, NO_TOKEN_MESSAGE } from "../lib/api.js";
import { resolveProject } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

const MAX_TEXT_BYTES = 65536;
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).describe("Exact sandbox ID from sandbox_create or sandbox_list");
const path = z.string().min(1).refine(value => !value.includes("\0"), "Path must not contain NUL bytes");
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

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

export async function execInSandbox(ctx: ToolContext, sandboxId: string, command: string, cwd: string, timeoutMs: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!ctx.accessToken) throw new Error(NO_TOKEN_MESSAGE);
  try {
    const result = await request<{ stdout: string; stderr: string; exitCode: number; truncated?: boolean }>(ctx, `${route(sandboxId)}/exec`, "POST", {
      cmd: command, workdir: cwd, timeoutMs,
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

export function registerSandboxTools(server: McpServer, ctx: ToolContext) {
  server.registerTool("sandbox_list", {
    title: "List sandboxes",
    description: "List Lizard Sandboxes in an explicit project. Use the returned IDs with sandbox tools; these resources are separate from app services.",
    inputSchema: { project: z.string().min(1) }, annotations: readOnly,
  }, handle(async ({ project }) => {
    const resolved = await resolveProject(ctx.api, project);
    return ctx.api.get(`/api/projects/${encodeURIComponent(resolved.id)}/sandboxes`);
  }));

  server.registerTool("sandbox_show", {
    title: "Show sandbox",
    description: "Read a sandbox's status, project, template, and expiry. The platform checks the current user's access to this ID.",
    inputSchema: { sandboxId: id }, annotations: readOnly,
  }, handle(async ({ sandboxId }) => {
    return ctx.api.get(route(sandboxId));
  }));

  server.registerTool("sandbox_create", {
    title: "Create sandbox",
    description: "Create an ephemeral interpreter sandbox in an explicit project. Uses billed cloud resources and returns its ID. The default lifetime is 5 minutes; expiry deletes its files. No host files, environment variables, or API key are copied into it. Get the user's approval before creating it; do not retry an uncertain response blindly.",
    inputSchema: {
      project: z.string().min(1),
      lifetimeMs: z.number().int().min(60000).max(3600000).default(300000),
      confirm: z.literal(true),
    }, annotations: { ...write, destructiveHint: false, openWorldHint: false },
  }, handle(async ({ project, lifetimeMs }, extra) => {
    extra.signal.throwIfAborted();
    const resolved = await resolveProject(ctx.api, project);
    extra.signal.throwIfAborted();
    const sandbox = await ctx.api.post<{ sandboxId: string }>("/api/sandboxes", {
      template: "interpreter", projectId: resolved.id, size: "small", timeoutMs: lifetimeMs,
      metadata: { integration: "lizard-mcp" },
    });
    if (extra.signal.aborted) {
      await destroy(ctx, sandbox.sandboxId);
      extra.signal.throwIfAborted();
    }
    return { sandboxId: sandbox.sandboxId, projectId: resolved.id, template: "interpreter", workdir: "/workspace", lifetimeMs };
  }));

  server.registerTool("sandbox_exec", {
    title: "Run sandbox command",
    description: "Run a shell command inside an existing sandbox, as root. Requires the user's approval. Cancellation, timeout, or a failed command request destroys the whole sandbox and all its files to stop remote code. A nonzero command exit code preserves it. Use an ephemeral sandbox created for this task. Output is capped at 64 KiB per stream; do not blindly retry a failed command.",
    inputSchema: {
      sandboxId: id, command: z.string().trim().min(1), cwd: path.default("/workspace"),
      timeoutMs: z.number().int().min(1000).max(120000).default(60000),
      confirm: z.literal(true).describe("User approved the command and loss of sandbox files if cancellation, timeout, or request failure requires cleanup"),
    }, annotations: write,
  }, handle(async ({ sandboxId, command, cwd, timeoutMs }, extra) => {
    extra.signal.throwIfAborted();
    return execInSandbox(ctx, sandboxId, command, posix.resolve("/workspace", cwd), timeoutMs, extra.signal);
  }));

  server.registerTool("sandbox_read_file", {
    title: "Read sandbox text file",
    description: "Read up to 64 KiB of UTF-8 text from a sandbox. Relative paths start at /workspace. Paths refer to the remote sandbox, never the MCP server's files.",
    inputSchema: { sandboxId: id, path }, annotations: readOnly,
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
    description: "Write up to 64 KiB of UTF-8 text to a sandbox, replacing an existing file. Requires the user's approval. Relative paths start at /workspace. Does not write to the MCP server's filesystem.",
    inputSchema: {
      sandboxId: id, path,
      content: z.string().refine(value => Buffer.byteLength(value) <= MAX_TEXT_BYTES, "Content exceeds 64 KiB"),
      confirm: z.literal(true),
    }, annotations: { ...write, idempotentHint: true, openWorldHint: false },
  }, handle(async ({ sandboxId, path: file, content }, extra) => {
    extra.signal.throwIfAborted();
    const resolved = posix.resolve("/workspace", file);
    await ctx.api.post(`${route(sandboxId)}/files`, { path: resolved, content });
    return { sandboxId, path: resolved, bytes: Buffer.byteLength(content) };
  }));

  server.registerTool("sandbox_delete", {
    title: "Delete sandbox",
    description: "Permanently destroy one sandbox and all its files. Get the user's approval before calling. Use this to clean up a sandbox created for a task. Does not delete its project or any app services.",
    inputSchema: { sandboxId: id, confirm: z.literal(true) },
    annotations: { ...write, idempotentHint: true, openWorldHint: false },
  }, handle(async ({ sandboxId }, extra) => {
    extra.signal.throwIfAborted();
    return { sandboxId, deleted: await destroy(ctx, sandboxId) };
  }));
}
