import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApiClient, type ApiClient } from "./lib/api.js";
import { registerAccountTools } from "./tools/account.js";
import { registerServiceTools } from "./tools/services.js";
import { registerDeployTools } from "./tools/deploy.js";
import { registerLogsTools } from "./tools/logs.js";
import { registerMetricsTools } from "./tools/metrics.js";
import { registerSecretsTools } from "./tools/secrets.js";
import { registerDomainTools } from "./tools/domains.js";
import { registerVolumeTools } from "./tools/volumes.js";
import { registerGitTools } from "./tools/git.js";
import { registerConfigTools } from "./tools/config.js";
import { registerTemplateTools } from "./tools/templates.js";
import { registerFunctionsTools } from "./tools/functions.js";
import { registerSandboxTools } from "./tools/sandboxes.js";
import { registerRepoTools } from "./tools/repos.js";
import { registerSupportTools } from "./tools/support.js";
import { supportNotice, withNotice } from "./lib/support-inbox.js";

// For a host that runs the tools in-process (the platform, at lizard.build/mcp).
export { setPlatformUrl } from "./lib/api.js";

export interface ToolContext {
  api: ApiClient;
  /** The raw access token, for tools such as logs.tail build mode
   *  that need to make their own SSE requests instead of going
   *  through ctx.api's plain JSON request/response shape. */
  accessToken: string;
}

export const INSTRUCTIONS = `
Lizard is a cloud for apps, databases and sandboxes: deploy GitHub or Lizard Git repos as
containerized apps, provision managed Postgres/Redis/S3 addons, and manage them (logs,
metrics, secrets, domains, scaling, volumes, shell exec); run code in Lizard Sandboxes; host
repositories, pull requests and CI on Lizard Git — scoped to the authenticated user's own
workspaces and projects.

## Sandboxes

Lizard Sandboxes run code in Firecracker microVMs, separate from app services.
Use sandbox_create with an explicit project and finite lifetime (default 5 minutes, at most
a day; sandbox_set_timeout changes it), then sandbox_exec, sandbox_read_file,
sandbox_write_file and sandbox_list_files with its returned ID. Clean up with
sandbox_delete when the task ends. These tools do not deploy an app.
sandbox_pause keeps files and stops billing for compute (processes end; the resume boots fresh);
sandbox_resume brings it back. sandbox_snapshot saves a running sandbox's files to
start new ones from in the same project (sandbox_create with snapshotId); sandbox_fork starts live copies.
sandbox_expose_port gives a port an HTTPS URL that carries its access token. A persistent volume (volume_create,
then sandbox_create with volume) keeps files after the sandbox is gone.
Creation uses billed resources. Create, execute, write, and delete require confirm:true
after the user approves the action. For sandbox_exec, approval includes destruction of
the whole sandbox if cancellation, timeout, or a failed request requires cleanup.
Never use it on a sandbox whose files the user needs to keep. A failed request can have
side effects; inspect the sandbox before retrying. Keys stay in the MCP server and each
request uses only the current caller's access token.

## Mental model

workspace -> project -> service (app or addon)

Most tools take a "project" (name/slug/ID) and a "service" (name/ID) param. If unsure
which project/service the user means, call workspace_list / project_list / service_list
first rather than guessing — resolution is by exact name match, not fuzzy.

## Domains — do not guess a hostname

Every app is assigned a *.onlizard.com domain automatically, but not until its build
finishes and it boots — this can take anywhere from seconds to a few minutes. The
"domain" field is null until then, on service_create's response and on service_show
alike. A null/empty domain right after creating or redeploying a service is normal, not
an error — it does NOT mean a domain wasn't assigned, only that it isn't assigned *yet*.

Never fabricate, guess, or predict what the hostname will look like, even as a
placeholder — a plausible-looking fake domain is worse than no domain, because the user
may try to use it. If the user asks for the domain right after a deploy and it's still
null, say the deploy is still in progress and the domain will be available once it
finishes; poll service_show or deploy_events and report back the real value once
"domain" is actually non-null. Only call domain_attach when the user explicitly wants to
bring their own custom domain (pass hostname), or when service_show shows no domain
after the deploy has actually finished — e.g. the service was created with
skipInitialDeploy and never deployed.

## Regions — do not guess a code

Region codes are opaque platform identifiers, not something to infer from a place name.
service_create, addon_create, volume_create and sandbox_create use us-east-1 when region
is left out. To put something elsewhere, take the code from region_list.

## Secrets: scope and precedence

Two scopes: project-wide ("global", omit the service param) and per-service (pass
service). Default to service-scope — global exposes the value to every service in the
project, including ones that don't need it. Only use global for genuinely non-secret,
provably-shared values (log level, NODE_ENV, feature flags).

Precedence (last wins): addon-issued env < project secrets < project env < app env <
app secrets < platform vars. Platform vars (service name, project ID, PORT, public
domain) are last and cannot be overridden.

Check secrets_list before secrets_set/secrets_delete to avoid creating a duplicate key
or silently shadowing one at a different scope.

## Referencing an addon from a service

Addons don't get separate credentials handed to the user — a consuming service
references the addon's env vars via \${{<addon-name>.<KEY>}} in its own secrets (set
with secrets_set), resolved at deploy time. Use secrets_refs to see exactly which
addon/key combinations are available in a project before wiring a reference. A ref to a
missing addon or key silently resolves to an empty string rather than failing the
deploy — after wiring one, it's worth confirming the consumer actually received a
value (e.g. via logs_tail, or a page of the app that shows it) rather than assuming success.

## What triggers a rebuild vs. just a restart

- deploy_redeploy, git_checkout, or a push to the tracked branch: full rebuild.
- service_set on build-affecting fields (repoUrl, branch, sourceType, buildCommand,
  dockerfilePath, rootDirectory): auto-rebuilds — do not also call deploy_redeploy
  right after, that queues a redundant second build.
- service_set on runtime-only fields (startCommand, preDeployCommand, containerPort,
  watchPatterns): no auto-rebuild — follow with deploy_redeploy to apply.
- secrets_set / secrets_delete: applied live, service restarts to pick them up, no
  rebuild needed.

## Pausing instead of deleting

- service_pause / project_pause / workspace_pause stop services without deleting anything:
  each scales to 0 (app URL answers 503, database refuses connections) and keeps its URL,
  database host, port, password, settings and volumes. Resume with *_resume; the service
  starts again from the same image with its data. Prefer this over service_delete when the
  user wants to stop paying for something they may want back.
- A paused service is not restarted or redeployed (those return an error) until resumed.
- project_delete puts services and databases in trash for 3 days, but deletes the
  project's sandboxes, their volumes and snapshots at once. Say so before asking.
- service_sleep_set makes a service serverless (sleeps when idle with its memory saved,
  wakes in ~1 s on the next request) or always on. Unlike pause, a sleeping service wakes
  by itself.

## Lizard Git

Lizard Git (lizard.build/git) is Lizard's own git hosting. repo_* tools read and change
its repositories (every commit is made on the server with repo_commit; there is no clone),
pr_* tools handle pull requests, ci_* tools read CI runs and logs. The git_* tools are about
a service's GitHub connection, not Lizard Git. To deploy a Lizard Git repo, call
service_create with repoUrl lizard:owner/name. Lizard Git refuses API keys with scopes.

## Sandbox limits

The trial runs 1 Small and 2 Mini at a time (US regions only); Medium and Large unlock
after the first payment. On the trial, Medium or Large fails with TRIAL_SANDBOX_SIZE,
another region with TRIAL_SANDBOX_REGION, and a second Small or a third Mini with
TRIAL_SIZE_RUNNING (pause or delete one, or use the other size). A trial sandbox lives
1 hour at most, then it is deleted: a longer lifetime fails with TRIAL_SANDBOX_LIFETIME, and
sandbox_set_timeout cannot extend it past 1 hour from its creation (latestExpiresAt).
Paid accounts' limit counts vCPU of running sandboxes (Mini 1, Small 2, Medium 4, Large 8;
paused ones don't count), across all of the owner's workspaces: 40 vCPU on Pro, 220 on
Pro 5x, 1,200 on Pro 20x. Past it, sandbox_create, sandbox_fork
and sandbox_resume fail with SANDBOX_LIMIT_REACHED; the error's structuredContent has
unit ("vcpu"), limit, running (vCPU in use) and needed. Pause or delete an idle sandbox,
pick a smaller size, or tell the user a higher Pro tier raises it (billing_status lists
the tiers). Starts are limited on the trial and Pro, per day: 100 and 400 (per
minute 6, 24; per hour 30, 120). Pro 5x and Pro 20x have unlimited starts. Past one, SANDBOX_RATE_LIMITED has retryAfterS: wait that long. On the trial, the first
paid invoice raises the day's 100 starts to 400.

## Workspace limits

A workspace owner can cap running sandboxes, CPU, memory and disk (workspace_limits_set).
A call that fails with WORKSPACE_SANDBOX_LIMIT or WORKSPACE_USAGE_LIMIT will fail the same
way on retry: read workspace_limits_get, then pause or delete a sandbox, scale a service
down, or ask the owner to raise the limit.

## Support

When Lizard itself is broken, open a ticket with the support tool instead of working around it
silently: a tool fails twice with a server error or timeout, or a sandbox or service is stuck or
crashed with no cause in its own logs. Do that without asking (it describes Lizard's failure, not
the user's code), then tell the user the ticket id. When a plan or limit blocks the task and the
user needs more (vCPU, regions, sizes, a bigger plan), ask the user first, then open one with
kind "limits" or "billing". Fill expected, actual and repro; never include secrets, keys, source
code or customer data. Filing the same problem again returns similarId instead of a new ticket.
Never open tickets for the user's own build errors or app bugs. The team's replies are added to
the end of later tool results ("📬 Lizard support replied on T-…"): tell the user, and answer
questions with support_reply.

## Writes are immediate and real

There is no separate platform-side confirmation step — a tool call is the action.
Destructive tools (project_delete, workspace_delete, service_delete, secrets_delete,
domain_delete, volume_delete, sandbox_delete, sandbox_snapshot_delete, repo_delete) require confirm:true
in the call itself since there's no interactive prompt in MCP; still get the user's
explicit go-ahead in conversation before setting it. All write tools declare
destructiveHint:true so clients can ask before changing resources. Shell access to
services is unavailable; use sandbox_exec to run commands in a sandbox.

## Composition

Chain the calls a request implies and return one result, not a call-by-call
narration. E.g. "deploy this repo" -> resolve/create project -> service_create with
repoUrl -> report the assigned domain from the response, once it's ready. "Add a
database" -> addon_create -> tell the user the \${{name.KEY}} refs available (from
secrets_refs) rather than raw credentials.
`.trim();

/**
 * Builds one McpServer + one ToolContext per request, bound to the calling
 * user's access token. The endpoint is stateless and serves every user (see
 * lib/api.ts), so nothing here is cached or reused across requests.
 */
export function getServer(accessToken: string): McpServer {
  const server = new McpServer({ name: "lizard", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const ctx: ToolContext = { api: createApiClient(accessToken), accessToken };

  // Support replies the caller hasn't read ride along on the next tool results (lib/support-inbox.ts).
  const register = server.registerTool.bind(server) as (...a: any[]) => any;
  (server as any).registerTool = (name: string, config: unknown, cb: (...a: any[]) => any) =>
    register(name, config, name.startsWith("support")
      ? cb
      : async (...args: any[]) => withNotice(await cb(...args), await supportNotice(ctx.api, accessToken)));

  registerAccountTools(server, ctx);
  registerServiceTools(server, ctx);
  registerDeployTools(server, ctx);
  registerLogsTools(server, ctx);
  registerMetricsTools(server, ctx);
  registerSecretsTools(server, ctx);
  registerDomainTools(server, ctx);
  registerVolumeTools(server, ctx);
  registerGitTools(server, ctx);
  registerConfigTools(server, ctx);
  registerTemplateTools(server, ctx);
  registerFunctionsTools(server, ctx);
  registerSandboxTools(server, ctx);
  registerRepoTools(server, ctx);
  registerSupportTools(server, ctx);

  return server;
}
