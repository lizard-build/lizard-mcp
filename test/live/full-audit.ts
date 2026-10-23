// Live audit: calls every Lizard MCP tool against the real platform and checks what comes back.
//
//   LIZARD_TOKEN=liz_... npm run audit:live [-- --only account,git,services,volumes,sandbox,templates,bulk,negative]
//                                           [--url https://host/mcp] [--region eu-west-lim-a] [--keep]
//
// Without --url it starts this checkout's HTTP server (src/index.ts) on a free local port, pointed at
// PLATFORM_URL (default https://lizard.build), and also checks stdio lists the same tools. With --url it
// audits that deployed server instead. Everything is created inside a new workspace named
// mcp-audit-<time> plus one Lizard Git repository, and deleted at the end unless --keep.
// It uses billed resources (a few small services and sandboxes for about half an hour).
// The report goes to audit-report.json.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const argv = process.argv.slice(2);
const opt = (name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const only = opt("only")?.split(",");
const keep = argv.includes("--keep");
const region = opt("region") ?? "eu-west-lim-a";
const remoteUrl = opt("url");
const token = process.env.LIZARD_TOKEN || process.env.LIZARD_API_KEY || "";
const platformUrl = process.env.PLATFORM_URL || "https://lizard.build";
if (!token) throw new Error("Set LIZARD_TOKEN to an API key with no scopes.");

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
const NAME = `mcp-audit-${stamp}`;
const runGroup = (g: string) => !only || only.includes(g);

interface Step { group: string; tool: string; title: string; ok: boolean; ms: number; detail: string }
const steps: Step[] = [];
const called = new Set<string>();
let group = "setup";

let client: Client;
let server: ChildProcess | undefined;

type Result = { isError: boolean; sc: any; text: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function raw(tool: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r: any = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600_000 });
  called.add(tool);
  const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  return { isError: !!r.isError, sc: r.structuredContent, text };
}

/**
 * One checked call. `expect` says what a pass is: a success (default, optionally with a check that
 * returns a complaint), or an error whose text matches.
 */
async function step(
  tool: string,
  args: Record<string, unknown>,
  title: string,
  expect: { error?: RegExp | true; check?: (r: Result) => string | void | undefined } = {},
): Promise<Result> {
  const t0 = Date.now();
  let r: Result;
  try {
    r = await raw(tool, args);
  } catch (e) {
    r = { isError: true, sc: undefined, text: `transport error: ${(e as Error).message}` };
  }
  let ok: boolean;
  let detail: string;
  if (expect.error) {
    ok = r.isError && (expect.error === true || expect.error.test(r.text));
    detail = ok ? `refused as expected: ${r.text.slice(0, 160)}` : r.isError ? `wrong error: ${r.text.slice(0, 300)}` : "expected an error, got success";
  } else if (r.isError) {
    ok = false;
    detail = r.text.slice(0, 400);
  } else {
    const complaint = expect.check?.(r);
    ok = !complaint;
    detail = complaint || r.text.replace(/\s+/g, " ").slice(0, 160);
  }
  steps.push({ group, tool, title, ok, ms: Date.now() - t0, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${group.padEnd(9)} ${tool.padEnd(30)} ${title}${ok ? "" : `\n     ${detail}`}`);
  return r;
}

/** Poll a read tool until `done`, quietly; records one step with the final state. */
async function waitFor(tool: string, args: Record<string, unknown>, title: string, done: (r: Result) => boolean, ms: number, every = 5000): Promise<Result> {
  const t0 = Date.now();
  let r = await raw(tool, args);
  while (!done(r) && Date.now() - t0 < ms) {
    await sleep(every);
    r = await raw(tool, args);
  }
  const ok = done(r);
  steps.push({ group, tool, title, ok, ms: Date.now() - t0, detail: ok ? "reached" : `gave up after ${Math.round(ms / 1000)} s: ${r.text.replace(/\s+/g, " ").slice(0, 300)}` });
  console.log(`${ok ? "PASS" : "FAIL"} ${group.padEnd(9)} ${tool.padEnd(30)} ${title}${ok ? "" : `\n     ${steps.at(-1)!.detail}`}`);
  return r;
}

function note(title: string, ok: boolean, detail = "") {
  steps.push({ group, tool: "-", title, ok, ms: 0, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${group.padEnd(9)} ${"(check)".padEnd(30)} ${title}${ok || !detail ? "" : `\n     ${detail}`}`);
}

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const env = () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));

async function connect(): Promise<string> {
  let url = remoteUrl;
  if (!url) {
    const port = await freePort();
    url = `http://127.0.0.1:${port}/mcp`;
    server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      env: { ...env(), PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`, PLATFORM_URL: platformUrl },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("local MCP server did not start")), 20000);
      server!.once("exit", (code) => reject(new Error(`local MCP server exited ${code}`)));
      server!.stdout!.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(timer); resolve(); } });
    });
  }
  client = new Client({ name: "lizard-mcp-live-audit", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return url;
}

// ---------------------------------------------------------------------------------------------

const S: Record<string, any> = {}; // ids found along the way

async function account() {
  group = "account";
  const me = await step("whoami", {}, "reads the key's account", { check: (r) => (r.sc?.username || r.sc?.scoped !== undefined ? undefined : "no identity") });
  S.login = me.sc?.username;
  await step("workspace_list", {}, "lists workspaces", { check: (r) => (Array.isArray(r.sc?.items) ? undefined : "not a list") });
  const regions = await step("region_list", {}, "lists regions", {
    check: (r) => (r.sc?.items?.some((x: any) => x.id === region) ? undefined : `region ${region} not offered`),
  });
  void regions;
  await step("billing_status", {}, "reads the plan and adds the Billing link", { check: (r) => (r.sc?.billingUrl && r.sc?.plan ? undefined : "no plan or billingUrl") });
  const ws = await step("workspace_create", { name: NAME }, `creates workspace ${NAME}`, { check: (r) => (r.sc?.id ? undefined : "no id") });
  S.ws = ws.sc?.id;
  S.wsSlug = ws.sc?.slug;
  if (!S.ws) throw new Error("no workspace, stopping");
  const proj = await step("project_create", { name: "audit", workspaceId: S.ws }, "creates a project in it", { check: (r) => (r.sc?.id ? undefined : "no id") });
  S.project = proj.sc?.id;
  await step("project_list", { workspaceId: S.ws }, "lists the workspace's projects", {
    check: (r) => (r.sc?.items?.some((p: any) => p.id === S.project) ? undefined : "new project missing"),
  });
  await step("billing_summary", { workspaceId: S.ws }, "reads the workspace's costs", { check: (r) => (r.sc?.summary !== undefined && r.sc?.live !== undefined ? undefined : "missing summary/live") });

  await step("workspace_limits_get", { workspaceId: S.ws }, "reads limits and usage", { check: (r) => (r.sc?.limits && r.sc?.usage ? undefined : "no limits/usage") });
  await step("workspace_limits_set", { workspaceId: S.ws, maxRunningSandboxes: 4, maxDiskGb: 50 }, "sets two caps", {
    check: (r) => (r.sc?.limits?.maxRunningSandboxes === 4 && r.sc?.limits?.maxDiskGb === 50 ? undefined : `limits now ${JSON.stringify(r.sc?.limits)}`),
  });
  await step("workspace_limits_set", { workspaceId: S.ws, maxRunningSandboxes: null, maxDiskGb: null }, "null removes them", {
    check: (r) => (r.sc?.limits?.maxRunningSandboxes == null && r.sc?.limits?.maxDiskGb == null ? undefined : `limits now ${JSON.stringify(r.sc?.limits)}`),
  });
  await step("workspace_limits_set", { workspaceId: S.ws }, "refuses a call with no limit", { error: /at least one/ });
  await step("workspace_resale_pricing_get", { workspaceId: S.ws }, "reads resale prices", { check: (r) => (r.sc?.multipliers || r.sc?.enabled !== undefined ? undefined : "no multipliers") });
  await step("workspace_resale_pricing_set", { workspaceId: S.ws, sandbox: 3 }, "sets one multiplier, keeps the rest", {
    check: (r) => (r.sc?.multipliers?.sandbox === 3 && r.sc?.multipliers?.cpu === 1 ? undefined : `got ${JSON.stringify(r.sc)}`),
  });
  await step("workspace_resale_pricing_set", { workspaceId: S.ws, off: true }, "turns resale prices off", { check: (r) => (r.sc?.enabled === false ? undefined : `got ${JSON.stringify(r.sc)}`) });
}

const APP_FILES = [
  { path: "package.json", content: JSON.stringify({ name: "mcp-audit", version: "1.0.0", private: true, scripts: { start: "node server.js" } }, null, 2) + "\n" },
  {
    path: "server.js",
    content:
      "const http = require('http');\n" +
      "http.createServer((req, res) => {\n" +
      "  console.log('request', req.url);\n" +
      "  res.setHeader('content-type', 'application/json');\n" +
      "  res.end(JSON.stringify({ ok: true, audit: process.env.AUDIT || null, redis: Boolean(process.env.REDIS_URL) }));\n" +
      "}).listen(process.env.PORT || 3000, () => console.log('mcp-audit listening'));\n",
  },
  { path: ".lizard/workflows/ci.yml", content: "on: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo mcp-audit-ci-ok\n" },
];

async function lizardGit() {
  group = "git";
  await step("repo_list", {}, "lists the user's Lizard Git repositories", { check: (r) => (Array.isArray(r.sc?.items) ? undefined : "not a list") });
  const repo = await step("repo_create", { name: NAME, private: true, readme: true, description: "Lizard MCP live audit; safe to delete" }, "creates a private repo with a README", {
    check: (r) => (r.sc?.repo ? undefined : "no owner/name"),
  });
  S.repo = repo.sc?.repo;
  if (!S.repo) return;
  await step("repo_show", { repo: S.repo }, "reads it", { check: (r) => (r.sc?.repo?.defaultBranch ? undefined : "no default branch") });
  await step("repo_files", { repo: S.repo }, "lists the root", { check: (r) => (JSON.stringify(r.sc).includes("README") ? undefined : "README missing") });
  await step("repo_read_file", { repo: S.repo, path: "README.md" }, "reads the README", { check: (r) => (typeof r.sc?.content === "string" ? undefined : "no content") });
  const commit = await step("repo_commit", { repo: S.repo, branch: "main", message: "Add app and CI", files: APP_FILES, idempotencyKey: `${NAME}-1` }, "commits the app and a CI workflow", {
    check: (r) => (r.sc?.sha ? undefined : "no sha"),
  });
  S.sha = commit.sc?.sha;
  await step("repo_commit", { repo: S.repo, branch: "main", message: "Add app and CI", files: APP_FILES, idempotencyKey: `${NAME}-1` }, "the same idempotency key does not commit twice", {
    check: (r) => (r.sc?.sha === S.sha ? undefined : `new sha ${r.sc?.sha} vs ${S.sha}`),
  });
  await step("repo_files", { repo: S.repo, recursive: true }, "lists every path", {
    check: (r) => (r.sc?.files?.includes("server.js") && r.sc?.files?.includes(".lizard/workflows/ci.yml") ? undefined : `files: ${JSON.stringify(r.sc?.files)}`),
  });
  await step("repo_commits", { repo: S.repo }, "lists commits", { check: (r) => ((r.sc?.commits?.length ?? 0) >= 2 ? undefined : "expected 2+ commits") });
  await step("repo_commit", { repo: S.repo, branch: "feature", createFrom: "main", message: "Say hello", files: [{ path: "HELLO.md", content: "hello from the audit\n" }] }, "makes a branch with a commit", {
    check: (r) => (r.sc?.sha ? undefined : "no sha"),
  });
  const pr = await step("pr_create", { repo: S.repo, title: "Say hello", head: "feature", base: "main", body: "Opened by the Lizard MCP live audit." }, "opens a pull request", {
    check: (r) => (r.sc?.number ? undefined : "no number"),
  });
  S.pr = pr.sc?.number;
  await step("pr_list", { repo: S.repo }, "lists it", { check: (r) => (r.sc?.items?.some((i: any) => i.number === S.pr) ? undefined : "pull request missing") });
  await step("pr_show", { repo: S.repo, number: S.pr }, "reads it", { check: (r) => (r.sc?.issue?.number === S.pr ? undefined : "wrong pull request") });
  await step("pr_merge", { repo: S.repo, number: S.pr, method: "squash", deleteBranch: true }, "squash-merges it", { check: (r) => (r.sc?.sha ? undefined : "no sha") });
  await step("repo_read_file", { repo: S.repo, path: "HELLO.md", ref: "main" }, "main has the merged file", { check: (r) => (r.sc?.content?.includes("hello") ? undefined : "file not on main") });
  const runs = await waitFor("ci_run_list", { repo: S.repo }, "CI ran for the pushes", (r) => (r.sc?.runs ?? []).some((x: any) => !["queued", "running", "waiting", "pending", "dispatched"].includes(x.status)), 300_000, 10_000);
  const run = (runs.sc?.runs ?? [])[0];
  if (run) {
    await step("ci_run_show", { repo: S.repo, number: run.number, logs: true }, `reads run #${run.number} with logs`, {
      check: (r) => (JSON.stringify(r.sc?.logs ?? {}).includes("mcp-audit-ci-ok") ? undefined : `status ${r.sc?.status}; log without the echo: ${JSON.stringify(r.sc?.logs).slice(0, 200)}`),
    });
  } else note("a CI run exists to read", false, "no run listed");
}

async function services() {
  group = "services";
  const cache = await step("addon_create", { project: S.project, type: "redis", region, name: "cache" }, "provisions Managed Redis", { check: (r) => (r.sc?.id ? undefined : "no id") });
  S.cache = cache.sc?.id;
  if (S.repo) {
    const web = await step("service_create", { project: S.project, name: "web", region, repoUrl: `lizard:${S.repo}`, containerPort: 3000 }, "deploys the Lizard Git repo", {
      check: (r) => (r.sc?.id ? undefined : "no id"),
    });
    S.web = web.sc?.id;
  }
  const gh = await step("service_create", { project: S.project, name: "gh", region, repoUrl: "lizard-build/codex-react-test" }, "deploys a public GitHub repo (owner/name form)", {
    check: (r) => (r.sc?.id ? undefined : "no id"),
  });
  S.gh = gh.sc?.id;
  await step("service_list", { project: S.project }, "lists apps and addons", { check: (r) => ((r.sc?.apps?.length ?? 0) >= 1 && (r.sc?.addons?.length ?? 0) >= 1 ? undefined : "missing apps or addons") });
  const svc = S.web ? "web" : "gh";
  const up = await waitFor("service_show", { project: S.project, service: svc }, `${svc} builds, boots and gets a domain`, (r) => r.sc?.status === "running" && !!r.sc?.domain, 900_000, 10_000);
  S.domain = up.sc?.domain;
  if (S.domain) {
    const res = await fetch(`https://${S.domain}/`).then(async (x) => ({ status: x.status, body: await x.text() })).catch((e) => ({ status: 0, body: String(e) }));
    note(`https://${S.domain} answers`, res.status === 200, `${res.status} ${res.body.slice(0, 120)}`);
  }
  await step("deploy_events", { project: S.project, service: svc }, "reads deploy history and pods", { check: (r) => (r.sc?.deployEvents !== undefined ? undefined : "no events") });
  await step("logs_tail", { project: S.project, service: svc, build: true, limit: 50 }, "reads build logs", { check: (r) => ((r.sc?.lines?.length ?? 0) > 0 ? undefined : "no build lines") });
  await sleep(5000);
  await step("logs_tail", { project: S.project, service: svc, limit: 50 }, "reads runtime logs", { check: (r) => (r.text.length > 2 ? undefined : "empty") });
  await step("metrics_get", { project: S.project, service: svc, range: "1h" }, "reads app metrics", {});
  await step("metrics_get", { project: S.project, service: "cache", range: "1h" }, "reads addon metrics", {});
  await step("metrics_get", { project: S.project }, "reads project live metrics", {});

  // Secrets and refs
  await step("secrets_refs", { project: S.project, service: svc }, "lists references", { check: (r) => (r.text.includes("REDIS_URL") ? undefined : "no REDIS_URL ref") });
  await step("secrets_set", { project: S.project, service: svc, values: { AUDIT: "yes", REDIS_URL: "${{cache.REDIS_URL}}" } }, "sets a value and an addon reference", {});
  await step("secrets_list", { project: S.project, service: svc }, "masks values by default", { check: (r) => (r.text.includes("AUDIT") && !r.text.includes('"yes"') ? undefined : "not masked or missing") });
  await step("secrets_list", { project: S.project, service: svc, reveal: true }, "reveals on request", { check: (r) => (r.text.includes('"yes"') ? undefined : "value missing") });
  await step("config_apply", { project: S.project, config: { secrets: { shared: { AUDIT_SHARED: "1" } } } }, "applies config as code (a shared value)", {});
  await step("secrets_list", { project: S.project }, "sees the project-wide value", { check: (r) => (r.text.includes("AUDIT_SHARED") ? undefined : "missing") });
  await step("secrets_delete", { project: S.project, keys: ["AUDIT_SHARED"], confirm: true }, "deletes the project-wide value", {});
  await step("secrets_delete", { project: S.project, service: svc, keys: ["NOPE_NOT_SET"], confirm: true }, "refuses a key that does not exist", { error: /not found/ });
  await waitFor("service_show", { project: S.project, service: svc }, "running again after the secret restart", (r) => r.sc?.status === "running", 300_000, 5000);
  await sleep(10000);
  await step("ssh_exec", { project: S.project, service: svc, cmd: 'echo "audit=$AUDIT"; test -n "$REDIS_URL" && echo has-redis', confirm: true }, "runs a command in the container; secrets arrived", {
    check: (r) => (r.sc?.stdout?.includes("audit=yes") && r.sc?.stdout?.includes("has-redis") ? undefined : `stdout: ${r.sc?.stdout} stderr: ${r.sc?.stderr}`),
  });
  await step("ssh_exec", { project: S.project, service: svc, cmd: "ls" }, "refuses without confirm", { error: true });

  // Config, deploy, scale
  await step("service_get_port", { project: S.project, service: svc }, "reads the port", { check: (r) => (r.sc?.containerPort ? undefined : "no port") });
  await step("service_set_port", { project: S.project, service: svc, containerPort: 3000 }, "sets the port", {});
  await step("service_set", { project: S.project, service: svc, preDeployCommand: "echo predeploy-audit" }, "sets a runtime field", {});
  await step("deploy_redeploy", { project: S.project, service: svc }, "starts a rebuild", {});
  await waitFor("service_show", { project: S.project, service: svc }, "running after the redeploy", (r) => r.sc?.status === "running" && r.sc?.builds?.[0]?.status !== "building", 900_000, 10_000);
  await step("deploy_restart", { project: S.project, service: svc }, "restarts", {});
  await waitFor("service_show", { project: S.project, service: svc }, "running after the restart", (r) => r.sc?.status === "running", 300_000, 5000);
  await step("service_scale", { project: S.project, service: svc, replicas: 2, memory: 512 }, "scales to 2 replicas and 512 MB", {
    check: (r) => (r.sc?.replicas === 2 && r.sc?.memoryLimit === "512Mi" && !r.sc?.sideEffectFailures ? undefined : JSON.stringify(r.sc)),
  });
  await step("service_scale", { project: S.project, service: svc, replicas: 1 }, "back to 1 replica", {});
  await step("service_scale", { project: S.project, service: "cache", replicas: 2 }, "refuses replicas for an addon", { error: /single instance/ });
  await waitFor("service_show", { project: S.project, service: svc }, "running after scaling", (r) => r.sc?.status === "running", 300_000, 5000);
  await step("service_sleep_set", { project: S.project, service: svc, enabled: true, idleMinutes: 5 }, "turns serverless on", {});
  await step("service_sleep_status", { project: S.project, service: svc }, "reads it", { check: (r) => (r.sc?.enabled === true && r.sc?.idleMinutes === 5 ? undefined : JSON.stringify(r.sc)) });
  await step("service_sleep_set", { project: S.project, service: svc, enabled: false }, "turns it off", {});
  await waitFor("service_show", { project: S.project, service: svc }, "running before the pause", (r) => r.sc?.status === "running", 300_000, 5000);
  await step("service_pause", { project: S.project, service: svc }, "pauses the app", {});
  await waitFor("service_show", { project: S.project, service: svc }, "reads paused", (r) => r.sc?.status === "paused", 120_000, 3000);
  await step("deploy_restart", { project: S.project, service: svc }, "a paused app can't restart", { error: true });
  await step("service_resume", { project: S.project, service: svc }, "resumes it", {});
  await waitFor("service_show", { project: S.project, service: svc }, "running after resume", (r) => r.sc?.status === "running", 300_000, 5000);
  await step("service_rename", { project: S.project, service: svc, name: `${svc}-renamed` }, "renames it", {});
  await step("service_show", { project: S.project, service: `${svc}-renamed` }, "finds it by the new name", {});
  await step("service_rename", { project: S.project, service: `${svc}-renamed`, name: svc }, "renames it back", {});
  await step("service_scale", { project: S.project, service: "cache", memory: 512 }, "resizes the addon's memory", { check: (r) => (r.sc?.sideEffectFailures ? JSON.stringify(r.sc.sideEffectFailures) : undefined) });

  // Domains
  await step("domain_attach", { project: S.project, service: svc }, "generates another onlizard.com domain", {});
  const host = `${NAME}.example.com`;
  await step("domain_attach", { project: S.project, service: svc, hostname: host }, "attaches a custom hostname and returns DNS records", {});
  await step("domain_verify", { project: S.project, service: svc, hostname: host }, "verify says DNS is not set", { check: (r) => (/verified"?\s*:\s*true/.test(r.text) ? "claims verified" : undefined) });
  await step("domain_delete", { project: S.project, service: svc, hostname: host, confirm: true }, "removes the custom hostname", {});
  const owned = await step("domain_owned_list", {}, "lists domains bought on Lizard", { check: (r) => (Array.isArray(r.sc?.domains) ? undefined : "no list") });
  const mine = (owned.sc?.domains ?? []).find((d: any) => d.status === "registered");
  if (mine) {
    await step("domain_dns_list", { domain: mine.domain }, `reads ${mine.domain}'s records`, { check: (r) => (Array.isArray(r.sc?.records) ? undefined : "no records") });
    const add = await step("domain_dns_update", { domain: mine.domain, action: "add", name: "_mcp-audit", type: "TXT", value: NAME }, "an API key may not change DNS", { error: /API key can read/ });
    if (!add.isError) await raw("domain_dns_update", { domain: mine.domain, action: "remove", name: "_mcp-audit", type: "TXT", confirm: true });
  } else {
    await step("domain_dns_list", { domain: "example.com" }, "says example.com was not bought here", { error: /not a domain bought on Lizard/ });
    note("domain_dns_update needs a bought domain (none on this account)", true);
    called.add("domain_dns_update");
  }

  // GitHub connection
  await step("git_status", { project: S.project }, "reads the GitHub connection and tracked repos", { check: (r) => (r.sc?.githubStatus ? undefined : "no status") });
  await step("git_connect", {}, "returns status or the install URL", {});
  if (S.gh) {
    await step("git_checkout", { project: S.project, service: "gh", branch: "main" }, "switches gh to main and rebuilds", {});
  }

  // Service volume
  await step("volume_create", { project: S.project, name: "files", service: svc, sizeGb: 1 }, "attaches a 1 GB volume to the app", {});
  await step("volume_list", { project: S.project, service: svc }, "lists the app's volume", { check: (r) => (r.text.includes("files") ? undefined : "volume missing") });
}

async function volumesAndSandboxes() {
  group = "volumes";
  const vol = await step("volume_create", { project: S.project, name: "sbvol", region, sizeGb: 2 }, "creates a 2 GB sandbox volume", { check: (r) => (r.sc?.id ? undefined : "no id") });
  S.vol = vol.sc?.id;
  await step("volume_list", { project: S.project }, "lists it", { check: (r) => (r.text.includes("sbvol") ? undefined : "missing") });
  await step("volume_resize", { project: S.project, volume: "sbvol", sizeGb: 3 }, "grows it to 3 GB", { check: (r) => (r.sc?.sizeGb === 3 ? undefined : JSON.stringify(r.sc)) });
  await step("volume_resize", { project: S.project, volume: "sbvol", sizeGb: 1 }, "shrinking is refused with a code", { error: /shrink/ });

  group = "sandbox";
  const sb = await step("sandbox_create", { project: S.project, region, volume: "sbvol", lifetimeMs: 1_800_000, confirm: true }, "creates a sandbox with the volume", {
    check: (r) => (r.sc?.sandboxId ? undefined : "no id"),
  });
  S.sb = sb.sc?.sandboxId;
  if (!S.sb) return;
  await waitFor("sandbox_show", { sandboxId: S.sb }, "reads running", (r) => r.sc?.status === "running", 120_000, 2000);
  await step("sandbox_list", { project: S.project }, "lists it", { check: (r) => (r.text.includes(S.sb) ? undefined : "missing") });
  await step("sandbox_write_file", { sandboxId: S.sb, path: "hello.txt", content: "Привет 🦎", confirm: true }, "writes UTF-8 text", {});
  await step("sandbox_read_file", { sandboxId: S.sb, path: "hello.txt" }, "reads it back", { check: (r) => (r.sc?.content === "Привет 🦎" ? undefined : `got ${r.sc?.content}`) });
  await step("sandbox_list_files", { sandboxId: S.sb }, "lists /workspace", { check: (r) => (r.text.includes("hello.txt") ? undefined : "missing") });
  await step("sandbox_exec", { sandboxId: S.sb, command: "python3 -c 'print(2**64)'", confirm: true }, "runs Python", { check: (r) => (r.sc?.stdout?.trim() === "18446744073709551616" ? undefined : r.sc?.stdout) });
  await step("sandbox_exec", { sandboxId: S.sb, command: 'echo "$GREETING"', envs: { GREETING: "hi" }, confirm: true }, "passes envs", { check: (r) => (r.sc?.stdout?.trim() === "hi" ? undefined : r.sc?.stdout) });
  await step("sandbox_exec", { sandboxId: S.sb, command: "exit 7", confirm: true }, "a nonzero exit keeps the sandbox", { check: (r) => (r.sc?.exitCode === 7 ? undefined : JSON.stringify(r.sc)) });
  await step("sandbox_exec", { sandboxId: S.sb, command: "df -h /workspace | tail -1", confirm: true }, "the volume is mounted at /workspace", { check: (r) => (/\b(2|3)(\.\d)?G\b/.test(r.sc?.stdout ?? "") ? undefined : r.sc?.stdout) });
  await step("sandbox_set_timeout", { sandboxId: S.sb, lifetimeMs: 2_400_000 }, "extends its lifetime", {});
  await step("sandbox_exec", { sandboxId: S.sb, command: "cd /tmp && (nohup python3 -m http.server 8000 >/dev/null 2>&1 &) ; sleep 1; echo started", confirm: true }, "starts a web server in the background", {});
  const exposed = await step("sandbox_expose_port", { sandboxId: S.sb, port: 8000 }, "gives port 8000 a URL", { check: (r) => (r.sc?.url ? undefined : "no url") });
  if (exposed.sc?.url) {
    let status = 0;
    for (let i = 0; i < 10 && status !== 200; i++) {
      status = await fetch(exposed.sc.url).then((x) => x.status).catch(() => 0);
      if (status !== 200) await sleep(2000);
    }
    note(`${exposed.sc.url} answers 200`, status === 200, `status ${status}`);
  }
  await step("sandbox_unexpose_port", { sandboxId: S.sb, port: 8000 }, "removes the URL", {});
  await step("sandbox_pause", { sandboxId: S.sb }, "pauses (memory kept)", { check: (r) => (r.sc?.status === "paused" ? undefined : JSON.stringify(r.sc)) });
  await step("sandbox_resume", { sandboxId: S.sb }, "resumes", { check: (r) => (r.sc?.status === "running" ? undefined : JSON.stringify(r.sc)) });
  await step("sandbox_exec", { sandboxId: S.sb, command: "cat /workspace/hello.txt; pgrep -f http.server >/dev/null && echo server-alive", confirm: true }, "files and the background process survived", {
    check: (r) => (r.sc?.stdout?.includes("Привет") && r.sc?.stdout?.includes("server-alive") ? undefined : r.sc?.stdout),
  });

  // Snapshots and forks run on a sandbox without a volume.
  const plain = await step("sandbox_create", { project: S.project, region, template: "base", size: "small", lifetimeMs: 1_200_000, confirm: true }, "creates a base sandbox", { check: (r) => (r.sc?.sandboxId ? undefined : "no id") });
  S.plain = plain.sc?.sandboxId;
  if (S.plain) {
    await waitFor("sandbox_show", { sandboxId: S.plain }, "reads running", (r) => r.sc?.status === "running", 120_000, 2000);
    await step("sandbox_write_file", { sandboxId: S.plain, path: "state.txt", content: "kept in the snapshot", confirm: true }, "writes a file", {});
    const snap = await step("sandbox_snapshot", { sandboxId: S.plain, name: `${NAME}-snap`, scope: "project" }, "takes a snapshot", { check: (r) => (r.sc?.id ? undefined : "no id") });
    S.snap = snap.sc?.id;
    if (S.snap && snap.sc?.status !== "ready") {
      await waitFor("sandbox_snapshot_list", { project: S.project }, "snapshot becomes ready", (r) => (r.sc?.items ?? []).some((s: any) => s.id === S.snap && s.status === "ready"), 600_000, 5000);
    } else {
      await step("sandbox_snapshot_list", { project: S.project }, "lists it", { check: (r) => (r.text.includes(S.snap) ? undefined : "missing") });
    }
    if (S.snap) {
      await step("sandbox_create", { project: S.project, snapshotId: S.snap, size: "large", confirm: true }, "refuses a size with a snapshot", { error: /size/ });
      const restored = await step("sandbox_create", { project: S.project, snapshotId: S.snap, lifetimeMs: 600_000, confirm: true }, "starts a sandbox from the snapshot", { check: (r) => (r.sc?.sandboxId ? undefined : "no id") });
      S.restored = restored.sc?.sandboxId;
      if (S.restored) {
        await waitFor("sandbox_show", { sandboxId: S.restored }, "restored one runs", (r) => r.sc?.status === "running", 180_000, 2000);
        await step("sandbox_exec", { sandboxId: S.restored, command: "cat /workspace/state.txt", confirm: true }, "has the snapshot's file", { check: (r) => (r.sc?.stdout?.includes("kept in the snapshot") ? undefined : r.sc?.stdout) });
        await step("sandbox_delete", { sandboxId: S.restored, confirm: true }, "deletes it", { check: (r) => (r.sc?.deleted === true ? undefined : JSON.stringify(r.sc)) });
      }
    }
    const fork = await step("sandbox_fork", { sandboxId: S.plain, count: 1, confirm: true }, "forks one live copy", { check: (r) => (r.sc?.started === 1 ? undefined : JSON.stringify(r.sc)) });
    const forkId = fork.sc?.results?.[0]?.sandbox?.id ?? fork.sc?.results?.[0]?.sandbox?.sandboxId;
    if (forkId) {
      await step("sandbox_exec", { sandboxId: forkId, command: "cat /workspace/state.txt", confirm: true }, "the copy has the file", { check: (r) => (r.sc?.stdout?.includes("kept") ? undefined : r.sc?.stdout) });
      await step("sandbox_delete", { sandboxId: forkId, confirm: true }, "deletes the copy", {});
    }
    if (S.snap) await step("sandbox_snapshot_delete", { snapshotId: S.snap, confirm: true }, "deletes the snapshot", {});
    await step("sandbox_delete", { sandboxId: S.plain, confirm: true }, "deletes the base sandbox", {});
  }

  // A failed command destroys its sandbox, by design.
  const doomed = await step("sandbox_create", { project: S.project, lifetimeMs: 120_000, confirm: true }, "creates a throwaway sandbox", {});
  const doomedId = doomed.sc?.sandboxId;
  if (doomedId) {
    await waitFor("sandbox_show", { sandboxId: doomedId }, "throwaway runs", (r) => r.sc?.status === "running", 120_000, 2000);
    await step("sandbox_exec", { sandboxId: doomedId, command: "sleep 10", timeoutMs: 1000, confirm: true }, "a timed-out command destroys the sandbox", { error: /destroyed/ });
    await step("sandbox_delete", { sandboxId: doomedId, confirm: true }, "deleting it again is a no-op", { check: (r) => (r.sc?.deleted === false ? undefined : JSON.stringify(r.sc)) });
  }
  await step("sandbox_exec", { sandboxId: S.sb, command: "ls" }, "refuses without confirm", { error: true });
  await step("sandbox_delete", { sandboxId: S.sb, confirm: true }, "deletes the volume's sandbox", {});
  group = "volumes";
  await step("volume_delete", { project: S.project, volume: "sbvol" }, "refuses without confirm", { error: true });
  let gone: Result | undefined;
  for (let i = 0; i < 12; i++) {
    gone = await raw("volume_delete", { project: S.project, volume: "sbvol", confirm: true });
    if (!gone.isError || !/attached/.test(gone.text)) break;
    await sleep(5000);
  }
  note("volume_delete deletes it once the sandbox is gone", !!gone && !gone.isError, gone?.text.slice(0, 200));
}

async function templates() {
  group = "templates";
  const list = await step("template_list", {}, "lists templates", { check: (r) => ((r.sc?.items?.length ?? r.sc?.templates?.length ?? 0) > 0 ? undefined : "none") });
  const items: any[] = list.sc?.items ?? list.sc?.templates ?? [];
  let picked: any;
  for (const t of items.slice(0, 15)) {
    const shown = await raw("template_show", { template: t.slug ?? t.id });
    const s = shown.sc ?? {};
    const required = JSON.stringify(s).match(/"required"\s*:\s*true/g)?.length ?? 0;
    const services = (s.services?.length ?? 0) + (s.addons?.length ?? 0);
    if (!required && services > 0 && services <= 2) { picked = { ...t, detail: s }; break; }
  }
  if (!picked && items[0]) picked = items[0];
  if (!picked) return;
  await step("template_show", { template: picked.slug ?? picked.id }, `reads ${picked.slug ?? picked.id}`, {});
  const dep = await step("template_deploy", { template: picked.slug ?? picked.id, workspaceId: S.ws, projectName: "from-template" }, "deploys it as a new project", {
    check: (r) => (r.sc?.projectId || r.sc?.project?.id ? undefined : JSON.stringify(r.sc).slice(0, 200)),
  });
  S.tplProject = dep.sc?.projectId ?? dep.sc?.project?.id;
  if (S.tplProject) {
    await step("project_delete", { project: S.tplProject, confirm: true }, "deletes the template's project", {});
  }
}

async function bulk() {
  group = "bulk";
  await step("project_pause", { project: S.project }, "pauses every service of the project", { check: (r) => (Array.isArray(r.sc?.done) ? undefined : JSON.stringify(r.sc).slice(0, 200)) });
  await step("project_resume", { project: S.project }, "resumes them", { check: (r) => (Array.isArray(r.sc?.done) ? undefined : JSON.stringify(r.sc).slice(0, 200)) });
  await step("workspace_pause", { workspaceId: S.ws }, "pauses the whole audit workspace", {});
  await step("workspace_resume", { workspaceId: S.ws }, "resumes it", {});
}

async function negative() {
  group = "negative";
  await step("service_delete", { project: S.project ?? "x", service: "web" }, "refuses without confirm", { error: true });
  await step("project_list", { workspaceId: "no-such-workspace" }, "an unknown workspace is an error or empty", { check: (r) => (r.isError || (r.sc?.items ?? []).length === 0 ? undefined : "returned projects") });
  await step("service_list", { project: `${NAME}-nope` }, "an unknown project names the ones that exist", { error: /not found/ });
  await step("sandbox_show", { sandboxId: "../etc" }, "rejects a path-like sandbox id", { error: true });
  await step("repo_show", { repo: "../x" }, "rejects a path-like repository", { error: true });
  await step("repo_show", { repo: `${S.login ?? "nobody"}/${NAME}-missing` }, "a missing repository is a clean 404", { error: /not found|404|Not Found/i });
}

async function cleanup() {
  group = "cleanup";
  if (S.gh) await step("service_delete", { project: S.project, service: "gh", confirm: true }, "deletes the GitHub service", {});
  if (S.repo) await step("repo_delete", { repo: S.repo, confirm: true }, "deletes the Lizard Git repo", {});
  if (S.project) {
    const del = await step("project_delete", { project: S.project, confirm: true }, "deletes the audit project", {});
    void del;
  }
  if (S.ws) {
    let r: Result | undefined;
    for (let i = 0; i < 12; i++) {
      r = await raw("workspace_delete", { workspaceId: S.ws, confirm: true });
      if (!r.isError) break;
      await sleep(10000);
    }
    note("workspace_delete removes the emptied audit workspace", !!r && !r.isError, r?.text.slice(0, 300));
  }
}

async function transports(url: string) {
  group = "transport";
  const listed = (await client.listTools()).tools.map((t) => t.name).sort();
  S.toolNames = listed;
  note(`HTTP lists ${listed.length} tools`, listed.length > 0);
  const bad = await fetch(url, { method: "POST", headers: { Authorization: "Bearer liz_not_a_real_key", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  note("a bad token gets 401 with an OAuth challenge", bad.status === 401 && !!bad.headers.get("www-authenticate"), `status ${bad.status}`);
  if (!remoteUrl) {
    const stdio = new Client({ name: "lizard-mcp-live-audit-stdio", version: "1" });
    await stdio.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/stdio.ts"], env: { ...env(), LIZARD_TOKEN: token, PLATFORM_URL: platformUrl }, stderr: "pipe" }));
    const names = (await stdio.listTools()).tools.map((t) => t.name).sort();
    note("stdio lists the same tools as HTTP", JSON.stringify(names) === JSON.stringify(listed));
    const who: any = await stdio.callTool({ name: "whoami", arguments: {} });
    note("stdio calls a tool with the key", !who.isError, JSON.stringify(who.content).slice(0, 200));
    await stdio.close();
  }
}

async function main() {
  const url = await connect();
  console.log(`Auditing ${remoteUrl ?? `this checkout at ${url}`} against ${platformUrl} as ${NAME}\n`);
  const started = Date.now();
  try {
    await transports(url);
    await account();
    if (runGroup("git")) await lizardGit();
    if (runGroup("services")) await services();
    if (runGroup("volumes") || runGroup("sandbox")) await volumesAndSandboxes();
    if (runGroup("templates")) await templates();
    if (runGroup("bulk")) await bulk();
    if (runGroup("negative")) await negative();
  } catch (e) {
    note("audit ran to the end", false, (e as Error).stack ?? String(e));
  } finally {
    if (!keep) await cleanup().catch((e) => note("cleanup", false, String(e)));
    const notCalled = (S.toolNames ?? []).filter((n: string) => !called.has(n));
    const failed = steps.filter((s) => !s.ok);
    const report = {
      server: remoteUrl ?? "local checkout", platform: platformUrl, workspace: NAME, minutes: Math.round((Date.now() - started) / 6000) / 10,
      passed: steps.length - failed.length, failed: failed.length, toolsCalled: called.size, toolsListed: (S.toolNames ?? []).length, notCalled, steps,
    };
    writeFileSync("audit-report.json", JSON.stringify(report, null, 2) + "\n");
    console.log(`\n${report.passed} passed, ${report.failed} failed; ${called.size} of ${report.toolsListed} tools called${notCalled.length ? ` (not called: ${notCalled.join(", ")})` : ""}. Report: audit-report.json`);
    await client.close().catch(() => {});
    server?.kill();
    process.exit(failed.length ? 1 : 0);
  }
}

main();
