import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { resolveProject, resolveService } from "../lib/resolve.js";
import { handle } from "../lib/tool-helpers.js";

const PLATFORM_URL = process.env.PLATFORM_URL || "https://lizard.build";

// Safety backstop only (not a designed feature): if a remote command produces
// no output at all for this long, give up rather than holding the MCP tool
// call open forever. Re-armed on every received line (see armIdleTimer
// below), so this is a genuine idle timeout — an actively-producing
// long-running command is not killed, only a truly silent one.
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;

export function registerSshTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "ssh.exec",
    {
      description:
        "Use this when the user wants to run a one-off shell command inside a running Lizard service's container and see its output. Waits for the command to finish. This executes arbitrary code in the user's own infrastructure on their behalf.",
      inputSchema: {
        project: z.string().min(1),
        service: z.string().min(1),
        cmd: z.string().describe("Shell command to execute (passed to /bin/sh on the VM)"),
      },
      annotations: { destructiveHint: true },
    },
    handle(async ({ project, service, cmd }) => {
      const proj = await resolveProject(ctx.api, project);
      const scope = { workspaceId: proj.workspaceId };
      const svc = await resolveService(ctx.api, proj.id, service, scope);
      if (svc.kind !== "app") throw new Error(`"${service}" is an addon — ssh works only for app services.`);
      return execAndCollect(svc.id, cmd, ctx.accessToken);
    }),
  );
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when the idle-timeout backstop fired before the command finished —
   *  stdout/stderr/exitCode reflect whatever was captured up to that point,
   *  not necessarily the command's real final state. */
  timedOut?: true;
}

async function execAndCollect(appId: string, cmd: string, accessToken: string): Promise<ExecResult> {
  const controller = new AbortController();
  const res = await fetch(`${PLATFORM_URL}/api/apps/${appId}/exec`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ cmd }),
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`exec failed: HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let exitCode: number | null = null;
  let sawError = false;
  let timedOut = false;

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };
  armIdleTimer();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (line === "") {
          currentEvent = "";
        } else if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).trimStart();
          armIdleTimer();
          if (currentEvent === "exit") {
            try {
              exitCode = JSON.parse(data).exitCode ?? 0;
            } catch {}
            // Keep consuming — matches lizard-cli's execStream, which never
            // stops early on seeing exit/error and instead drains to the
            // connection's natural end, tolerating any output the server
            // flushes after that event.
          } else if (currentEvent === "error") {
            sawError = true;
            stderrLines.push(data);
          } else {
            try {
              const parsed = JSON.parse(data);
              (parsed.stream === "stderr" ? stderrLines : stdoutLines).push(parsed.line ?? data);
            } catch {
              stdoutLines.push(data);
            }
          }
        }
      }
    }
  } catch (err) {
    // Our own idle-timeout abort surfaces as AbortError — expected, not a
    // failure; fall through and return whatever was captured so far instead
    // of discarding it.
    if (!(err instanceof Error && err.name === "AbortError")) throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    controller.abort();
    reader.cancel().catch(() => {});
  }

  return {
    stdout: stdoutLines.join("\n"),
    stderr: stderrLines.join("\n"),
    exitCode: exitCode ?? (sawError ? 1 : 0),
    ...(timedOut ? { timedOut: true as const } : {}),
  };
}
