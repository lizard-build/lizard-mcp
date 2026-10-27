import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { createGitClient, gitURL, qs, repoPath } from "../lib/lizard-git.js";
import { handle } from "../lib/tool-helpers.js";

const MAX_TEXT_BYTES = 65536;
const repo = z.string().regex(/^[^/\s]+\/[^/\s]+$/).describe('Lizard Git repository as "owner/name" (repo_list)');
const number = z.number().int().min(1);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const change = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

/** The last `max` bytes of a log, where the error usually is. */
export function tail(text: string, max = MAX_TEXT_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return { text, truncated: false };
  return { text: new TextDecoder().decode(bytes.subarray(bytes.length - max)).replace(/^�+/, ""), truncated: true };
}

/**
 * Lizard Git: repositories, pull requests and CI runs hosted on Lizard (lizard.build/git),
 * not GitHub. The git_* tools are about a service's GitHub connection.
 */
export function registerRepoTools(server: McpServer, ctx: ToolContext) {
  const git = createGitClient(ctx.accessToken);
  let login: string | null = null;
  const myLogin = async () => (login ??= (await git.get<{ login: string }>("/api/session")).login);

  server.registerTool("repo_list", {
    title: "List Lizard Git repositories",
    description:
      "List Lizard Git repositories (lizard.build/git — Lizard's own git hosting, not GitHub): by default the user's own and the ones they collaborate on. " +
      "owner narrows to one owner's; query searches names and descriptions. Lizard Git refuses API keys with scopes.",
    inputSchema: { owner: z.string().min(1).optional(), query: z.string().min(1).optional() },
    annotations: { title: "List Lizard Git repositories", ...readOnly },
  }, handle(async ({ owner, query }) => git.get(qs("/api/repos", { owner, member: owner ? undefined : await myLogin(), q: query }))));

  server.registerTool("repo_create", {
    title: "Create Lizard Git repository",
    description:
      "Create a Lizard Git repository. Private by default. readme: true starts it with a README (otherwise it is empty until the first repo_commit). " +
      "workspace (a workspace slug) makes that workspace's members its collaborators. To deploy it, service_create with repoUrl lizard:owner/name; every commit to its branch then deploys.",
    inputSchema: {
      name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
      description: z.string().max(500).optional(),
      private: z.boolean().default(true),
      readme: z.boolean().optional(),
      defaultBranch: z.string().min(1).optional().describe("Default main"),
      workspace: z.string().min(1).optional().describe("Workspace slug"),
    },
    annotations: { title: "Create Lizard Git repository", ...change },
  }, handle(async (args) => {
    const r = await git.post<{ owner: string; name: string }>("/api/repos", args);
    return { ...r, repo: `${r.owner}/${r.name}`, url: `${gitURL()}/${r.owner}/${r.name}` };
  }));

  server.registerTool("repo_show", {
    title: "Show Lizard Git repository",
    description: "Read a Lizard Git repository's details: default branch, visibility, the user's role, whether it is empty, branch and open issue/pull request counts.",
    inputSchema: { repo }, annotations: { title: "Show Lizard Git repository", ...readOnly },
  }, handle(async ({ repo: r }) => git.get(repoPath(r))));

  server.registerTool("repo_delete", {
    title: "Delete Lizard Git repository",
    description: "Permanently delete a Lizard Git repository with its branches, issues, pull requests and CI runs. Services deploying from it stop getting new deploys. Owner or admin only. Get the user's approval first; this cannot be undone.",
    inputSchema: { repo, confirm: z.literal(true) },
    annotations: { title: "Delete Lizard Git repository", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, handle(async ({ repo: r }) => {
    await git.delete(repoPath(r));
    return { repo: r, status: "deleted" };
  }));

  server.registerTool("repo_files", {
    title: "List repository files",
    description: "List a folder of a Lizard Git repository (path, default the root) at a ref (branch, tag or commit; default branch if omitted). recursive: true lists every file path instead. Uses the Lizard API; docs: https://lizard.build/docs/.",
    inputSchema: { repo, path: z.string().optional(), ref: z.string().min(1).optional(), recursive: z.boolean().optional() },
    annotations: { title: "List repository files", ...readOnly },
  }, handle(async ({ repo: r, path, ref, recursive }) => {
    if (recursive) {
      const files = await git.get<string[]>(qs(`${repoPath(r)}/files`, { ref }));
      const prefix = path ? path.replace(/\/?$/, "/") : "";
      return { files: prefix ? files.filter((f) => f.startsWith(prefix)) : files };
    }
    return git.get(qs(`${repoPath(r)}/tree`, { ref, path }));
  }));

  server.registerTool("repo_read_file", {
    title: "Read repository file",
    description: "Read a text file from a Lizard Git repository at a ref (default branch if omitted), up to 64 KiB. Binary or larger files return their size without content. Uses the Lizard API; docs: https://lizard.build/docs/.",
    inputSchema: { repo, path: z.string().min(1), ref: z.string().min(1).optional() },
    annotations: { title: "Read repository file", ...readOnly },
  }, handle(async ({ repo: r, path, ref }) => {
    const blob = await git.get<{ content?: string; size: number; binary?: boolean; tooLarge?: boolean; [k: string]: unknown }>(qs(`${repoPath(r)}/blob`, { path, ref }));
    if (blob.content !== undefined && Buffer.byteLength(blob.content) > MAX_TEXT_BYTES) {
      return { ...blob, content: undefined, tooLarge: true, note: "File exceeds 64 KiB." };
    }
    return blob;
  }));

  server.registerTool("repo_commit", {
    title: "Commit files to Lizard Git",
    description:
      "Commit changes to a branch of a Lizard Git repository, made on the server (no clone needed): each file is new text content, delete: true, or a rename with moveFrom. " +
      "createFrom makes the branch from that ref when it doesn't exist yet. With expect (the commit you based the change on), a branch that moved meanwhile is merged by the server and only a real conflict fails (409, with the paths). " +
      "Pass an idempotencyKey to make a retry safe. A commit to a branch a service deploys from starts a deploy, and to a branch with .lizard/workflows starts CI. Uses the Lizard Git API; docs: https://lizard.build/docs/.",
    inputSchema: {
      repo,
      branch: z.string().min(1),
      message: z.string().min(1),
      files: z.array(z.object({
        path: z.string().min(1),
        content: z.string().optional().describe("Full new text of the file"),
        delete: z.boolean().optional(),
        moveFrom: z.string().min(1).optional().describe("Rename: the old path"),
      })).min(1),
      expect: z.string().min(1).optional(),
      createFrom: z.string().min(1).optional(),
      idempotencyKey: z.string().min(1).max(200).optional(),
    },
    annotations: { title: "Commit files to Lizard Git", ...change },
  }, handle(async ({ repo: r, idempotencyKey, ...body }) => {
    for (const f of body.files) {
      if (!f.delete && f.content === undefined && !f.moveFrom) throw new Error(`${f.path}: pass content, delete: true or moveFrom.`);
    }
    return git.post(`${repoPath(r)}/commits`, body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined);
  }));

  server.registerTool("repo_commits", {
    title: "List repository commits",
    description: "List recent commits of a Lizard Git repository at a ref (default branch if omitted), optionally only those touching path. Uses the Lizard API; docs: https://lizard.build/docs/.",
    inputSchema: { repo, ref: z.string().min(1).optional(), path: z.string().min(1).optional(), page: z.number().int().min(1).optional() },
    annotations: { title: "List repository commits", ...readOnly },
  }, handle(async ({ repo: r, ...opts }) => git.get(qs(`${repoPath(r)}/commits`, opts))));

  server.registerTool("pr_list", {
    title: "List pull requests",
    description: "List pull requests of a Lizard Git repository (state open by default; closed, all).",
    inputSchema: { repo, state: z.enum(["open", "closed", "all"]).optional(), query: z.string().min(1).optional() },
    annotations: { title: "List pull requests", ...readOnly },
  }, handle(async ({ repo: r, state, query }) => git.get(qs(`${repoPath(r)}/issues`, { state, q: query, pulls: 1 }))));

  server.registerTool("pr_create", {
    title: "Open pull request",
    description: "Open a pull request in a Lizard Git repository from head (a branch, or owner:branch of a fork) into base (default branch if omitted). draft: true opens it as a draft.",
    inputSchema: {
      repo, title: z.string().min(1), head: z.string().min(1), base: z.string().min(1).optional(),
      body: z.string().optional(), draft: z.boolean().optional(),
    },
    annotations: { title: "Open pull request", ...change },
  }, handle(async ({ repo: r, ...opts }) => git.post(`${repoPath(r)}/issues`, opts)));

  server.registerTool("pr_show", {
    title: "Show pull request",
    description: "Read a Lizard Git pull request with its conversation, head commit, whether it can merge and what branch rules still need (approvals, checks).",
    inputSchema: { repo, number }, annotations: { title: "Show pull request", ...readOnly },
  }, handle(async ({ repo: r, number: n }) => git.get(`${repoPath(r)}/issues/${n}`)));

  server.registerTool("pr_merge", {
    title: "Merge pull request",
    description: "Merge a Lizard Git pull request: method merge (default), squash or rebase; deleteBranch removes the head branch afterwards. The base branch moves, which can start a deploy or CI. Get the user's go-ahead first.",
    inputSchema: {
      repo, number,
      method: z.enum(["merge", "squash", "rebase"]).optional(),
      message: z.string().min(1).optional(),
      deleteBranch: z.boolean().optional(),
    },
    annotations: { title: "Merge pull request", ...change },
  }, handle(async ({ repo: r, number: n, method, message, deleteBranch }) =>
    git.post(`${repoPath(r)}/pulls/${n}/merge`, { method: method ?? "merge", message, deleteBranch: !!deleteBranch })));

  server.registerTool("ci_run_list", {
    title: "List CI runs",
    description: "List recent CI runs of a Lizard Git repository (workflows in .lizard/workflows, GitHub Actions syntax), newest first; filter by branch, pull request number or status.",
    inputSchema: {
      repo, branch: z.string().min(1).optional(), pr: number.optional(),
      status: z.string().min(1).optional().describe("e.g. queued, running, success, failure, cancelled"),
    },
    annotations: { title: "List CI runs", ...readOnly },
  }, handle(async ({ repo: r, branch, pr, status }) => git.get(qs(`${repoPath(r)}/actions/runs`, { branch, pr, status }))));

  server.registerTool("ci_run_show", {
    title: "Show CI run",
    description: "Read one CI run of a Lizard Git repository with its jobs and steps. logs: true adds each job's log (the last 64 KiB of each, where failures usually are).",
    inputSchema: { repo, number, logs: z.boolean().optional() },
    annotations: { title: "Show CI run", ...readOnly },
  }, handle(async ({ repo: r, number: n, logs }) => {
    const run = await git.get<{ jobs?: Array<{ id: number; name: string }>; [k: string]: unknown }>(`${repoPath(r)}/actions/runs/${n}`);
    if (!logs) return run;
    const jobLogs: Record<string, { text: string; truncated: boolean }> = {};
    for (const job of run.jobs ?? []) {
      jobLogs[job.name] = tail(await git.text(`${repoPath(r)}/actions/jobs/${job.id}/log.txt`).catch((e: Error) => `(log unavailable: ${e.message})`));
    }
    return { ...run, logs: jobLogs };
  }));
}
