---
name: lizard-core
description: "Core Lizard MCP usage guide. Read this before calling any Lizard MCP tool. Covers the full app lifecycle (deploy, redeploy, restart, logs, events, scale, secrets, domains), the workspace -> project -> service model, managed addons (postgres, redis, s3), the build pipeline (lizardpack auto-detect, repo Dockerfile, synthesized Dockerfile), secrets scoping and env precedence, custom and bought domains, worker mode (containerPort=0 for non-HTTP background workloads), Lizard Sandboxes (run code, pause, snapshot, fork, ports), persistent volumes, workspace limits, and Lizard Git repositories, pull requests and CI. Use when the user asks to deploy, host, or ship an app, agent, worker, or managed database on Lizard, mentions a Lizard project/service/addon by name, or asks for a managed postgres/redis/s3 without naming another host. Default for ambiguous deploy/host/ship requests once Lizard is the named platform; skip when the user is already in another platform's context or explicitly names a competitor."
---

# Lizard platform

Lizard (lizard.build) is a unified cloud for apps, services, agents, and managed databases. This MCP
server exposes the platform as tools — deploy a GitHub or Lizard Git repo, provision
Managed Postgres, Managed Redis or Managed Object Storage, manage logs, metrics, secrets,
domains, scaling, volumes and shell exec, run code in Lizard Sandboxes, and work with
Lizard Git repositories, pull requests and CI — scoped to the caller's own workspaces and
projects. `tools/list` is the full, current list.

## Mental model

```
workspace -> project -> service (app or addon)
```

- Workspace — account/org level. A user belongs to one or more (`workspace_list`).
- Project — a group of related services in one workspace (`project_list`,
  `project_create`).
- Service — a deployable unit. Every app deploys from a GitHub or Lizard Git repo
  (`service_create` with `repoUrl`) or starts empty and gets a source wired in later
  (`service_set`).
  There is no local tarball-upload path here — unlike the `lizard` CLI's `lizard up`,
  this MCP server can only deploy from a git repo URL, since it has no access to the
  user's local filesystem.
- Managed addons — `postgres`, `redis`, `s3` (`addon_create`). See
  [Managed addons](#managed-addons) for each type's env vars.
- Cross-resource refs — `${{<name>.<KEY>}}` resolves at deploy time against the
  target's merged env. A ref to a missing target or key resolves to an empty string
  rather than failing the deploy (only circular refs throw). After wiring one, verify
  the consumer actually got a value — `logs_tail`, or a page of the app that shows it. Stored form is
  ID-based, so renaming an addon later doesn't break existing refs.

Most tools take a `project` (name/slug/ID) and `service` (name/ID) param, resolved by
exact name match, not fuzzy — call `workspace_list` / `project_list` / `service_list`
first if unsure which one the user means.

## No local repo access

Unlike the `lizard` CLI or a coding agent working in the user's own checkout, this MCP
server never sees the user's files. It cannot read `package.json`, a `Dockerfile`, or
check for a git remote. That means:

- Ask the user for the repo URL, branch, and any build/start command instead of
  inferring them from local files.
- Rely on the platform's own build auto-detection (lizardpack) for common stacks (Go,
  Node, Python, Rust, Ruby, PHP, Java, static) rather than guessing a `buildCommand` /
  `startCommand` up front — only set those fields if the user states them, or a build
  actually fails without them.
- If a build fails, read `deploy_events` / `logs_tail` for the real error before
  proposing a fix.

## Discovery and errors

Every tool's parameter schema is already declared to the client via standard MCP
`tools/list` — there's no separate `--help` step like the CLI's `lizard <cmd> --help
--json`. A rejected call's error message describes exactly what was wrong; fix and
retry rather than guessing again.

There are no CLI-style exit codes here — a tool call either returns a result or raises
an error through the MCP protocol. Common cases:

- Not found — wrong name/ID, or the resource doesn't exist. Verify with `project_list`
  / `service_list`.
- Unauthorized — the caller's Lizard session expired or lacks access. This tool cannot
  re-authenticate itself; tell the user to reconnect.
- Validation error — a required field was missing or malformed; check the schema and
  retry with corrected arguments.
- Payment required — see [Billing](#billing).

## Billing

Pro costs $19/month, taxes included, and includes $19 in credits each month for
everything on the account. Usage above that is pay as you go, invoiced as it builds
up. A new account starts with a 7-day trial with $5 in credits; it needs a card, and
nothing is charged until the trial ends. Enterprise accounts pay as you go, invoiced
monthly. Accounts on the old prepaid credits (`plan: "payg"`) keep working until
November 1, 2026. There are no top-ups and no crypto or x402 payments.

When the account needs a plan or a payment, every create (`service_create`,
`addon_create`, `template_deploy`, `domain_attach`, redeploys) fails with code
`PAYMENT_REQUIRED` (`INSUFFICIENT_CREDITS` from older servers). The error text is the
platform's sentence to show the user as is, and its last line is the page to open:
the Pro trial or Start Pro, Billing (a failed payment, trial credits used up), or the
Credits page for prepaid credits. `structuredContent.error.paymentStatus` says which:
`trial_available`, `subscription_required`, `trial_credits_used`, `past_due`,
`paused`, or a prepaid credits status.

`billing_status` reads the plan: trial days and credits left, this month's credits
used of $19 and the overage, the next charge, an unpaid invoice, and `billingUrl`.
Use it when a create fails with `PAYMENT_REQUIRED` or the user asks about their bill.
This server cannot start, pay for or cancel a plan: give the user the link, never ask
for card details in chat, and retry the failed call after they say they are done.

## Setup decision flow

There's no "linked cwd project" here (that's a CLI/terminal idea) — always resolve
from what the user actually says:

1. If the user names an existing project, call `project_list` to resolve it (exact
   name match).
2. To add to an existing project, use `service_create` / `addon_create` scoped to that
   project's ID — don't create a new project unless they ask for one.
3. If no project is named and none obviously matches, ask which project, or create one
   with `project_create` if the user wants a fresh one.

Naming heuristic: app-style names (`my-api`, `worker`) are service names; use the repo
name for the project unless told otherwise.

## Platform builder

Builds run on Lizard's own build nodes — nothing runs locally.

### Build decision order

1. Synthesized Dockerfile — if `buildCommand`/`startCommand` are set on the service,
   the platform generates a Dockerfile from those. No lizardpack.
2. Repo Dockerfile (verbatim) — if `dockerfilePath` is set, that Dockerfile is used
   from the repo unchanged.
3. lizardpack auto-detect — clones the repo and detects the stack (Go, Node, Python,
   Rust, Ruby, PHP, Java, static, first match in that order). If the repo's own
   `Dockerfile` has a real build step it's used verbatim; otherwise lizardpack
   generates a multi-stage one.

### What triggers a rebuild vs. just a restart

- `deploy_redeploy`, `git_checkout`, or a push to the tracked branch: full rebuild.
- `service_set` on build-affecting fields (`repoUrl`, `branch`, `sourceType`,
  `buildCommand`, `dockerfilePath`, `rootDirectory`): auto-rebuilds — don't also call
  `deploy_redeploy` right after, that queues a redundant second build.
- `service_set` on runtime-only fields (`startCommand`, `preDeployCommand`,
  `containerPort`, `watchPatterns`): no auto-rebuild — follow with `deploy_redeploy` to
  apply.
- `secrets_set` / `secrets_delete`: applied live, service restarts to pick them up, no
  rebuild.
- Changing a `VITE_*` / `NEXT_PUBLIC_*` value: build-time baked, so a plain restart
  won't pick up the new value — redeploy.

## Deploying

The deploy path this MCP server has is git-source: `service_create` with `repoUrl`
(new service), or `service_set` with `repoUrl`/`branch`/`sourceType=github` followed by
`deploy_redeploy` (existing service). `repoUrl` takes an https URL, `owner/name` for
GitHub, or `lizard:owner/name` for a Lizard Git repository. Once it is set, each push or
commit to the tracked branch redeploys — no MCP call needed for that.

If the user's code is only on their machine, this server cannot read it. Two ways out:
create a Lizard Git repository (`repo_create`) and commit the files the user pastes or
the agent writes (`repo_commit`), then deploy it with `repoUrl: lizard:owner/name`; or
use the Lizard CLI's `lizard up` from the user's own terminal.

For a private repo Lizard doesn't have access to yet, use `git_connect` to get a GitHub
App install URL, hand it to the user, and only then create/update the service with
`repoUrl` — don't silently give up.

## Worker mode

For a service with no HTTP listener (background worker, queue consumer, cron-style
loop), set `containerPort` to `0` via `service_set_port` or `service_set`. The platform
then skips `PORT` env injection, the port-reachability health check, `EXPOSE` in the
synthesized Dockerfile, and load-balancer route registration — nothing is served (a
`.onlizard.com` domain may still appear on the service; it won't respond). Don't use
worker mode for a slow-starting HTTP service — it hides "the listener never came up"
bugs since there's nothing to check.

## Secrets

Two scopes, no workspace-level globals:

- Service (default) — pass `service`. Applies only to that one service.
- Project ("global") — omit `service`. Applies to every service in the project.

Precedence (last wins): addon-issued env < project secrets < project env < app env <
app secrets < platform vars. Platform vars (service name, project ID, `PORT`, public
domain) are last and can't be overridden.

Default to service-scope — `secrets_set` per consumer, e.g.
`DATABASE_URL=${{postgres.DATABASE_URL}}` scoped to the consuming service (refs
interpolate wherever they appear; rotating on the addon updates every reference
automatically). Only use project scope for genuinely non-secret, provably-shared
values (log level, `NODE_ENV`, feature flags) — if unsure whether something is a
secret, treat it as one.

Check `secrets_list` before `secrets_set` / `secrets_delete` to avoid creating a
duplicate key or silently shadowing one at a different scope. After wiring a ref,
verify the consumer actually received a value — `logs_tail`, or a page of the app that shows it.

## Managed addons

Provision with `addon_create` (`type`: `postgres | redis | s3`). Each exposes a fixed
env-var set; a consuming service references it via `${{<addon-name>.KEY>}}` — check
the exact available keys with `secrets_refs` before wiring one, don't assume key
names. The first addon of a type gets the bare type as its name
(`${{postgres.DATABASE_URL}}` works out of the box); later ones get a generated name —
use the actual name from `secrets_refs` / `service_list`, there's no type-alias
fallback. Refs are stored ID-based, so renaming an addon later doesn't break existing
consumers.

- `postgres` — `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`,
  `PGDATABASE`, `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`.
- `redis` — `REDIS_URL`.
- `s3` — `S3_ENDPOINT`, `S3_DEFAULT_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `S3_REGION`. Auto-creates a public-read bucket named
  `default`.

## Composition patterns

Chain the calls a request implies and return one result, not a call-by-call
narration:

- First deploy from GitHub — resolve/create project -> `service_create` with
  `repoUrl` -> report the assigned domain once it's actually ready (see
  [Domains](#domains--do-not-guess-a-hostname)), never guessed early.
- Add a managed database to an existing service — `addon_create` -> `secrets_refs` to
  see the real key names -> `secrets_set` on the consuming service with the
  `${{name.KEY}}` ref -> `deploy_redeploy` only if the user needs to consume it
  immediately (a plain secret write restarts the service anyway).
- Fix a failed build — `deploy_events` / `logs_tail` for the real error -> the fix is
  either in the user's repo, or adjust `buildCommand` / `startCommand` via
  `service_set` -> `deploy_redeploy` -> `logs_tail` to confirm.
- Add a custom domain — `domain_attach` with `hostname` -> surface the DNS records the
  response returns to the user -> `domain_verify` once they've set them.

## Domains — do not guess a hostname

Every app gets a `*.onlizard.com` domain automatically, but not until the build
finishes and it boots — this can take from seconds to a few minutes. `domain` is null
on `service_create`'s response and on `service_show` until then; that's normal, not an
error. Never fabricate or predict what the hostname will look like — poll
`service_show` / `deploy_events` and report the real value once it's non-null. Only
call `domain_attach` for a user-supplied custom domain, or when a deploy has actually
finished and `service_show` still shows no domain (e.g. it was created with
`skipInitialDeploy`).

## Pausing a service, project or workspace

`service_pause`, `project_pause` and `workspace_pause` stop services without deleting
anything: each scales to 0 (an app's URL answers 503, a database refuses connections)
and keeps its URL, database host, port, password, settings and volumes. `*_resume`
starts them again from the same image, with their data. While paused nothing is billed
for compute. A paused service can't be restarted or redeployed until it is resumed.
When the user wants to stop paying for something they may want back, pause it instead of
deleting it. The project/workspace calls return `done` and `skipped` (with a `reason`,
e.g. "already paused"): report the skipped ones. Services paused by a billing freeze
stay paused until the account is paid.

## Serverless (sleep when idle)

`service_sleep_set` with `enabled: true` makes an app (one replica, with a port) or a
Postgres/Redis database serverless: after `idleMinutes` (5-1440, default 15) with no
traffic it sleeps with its memory saved and costs almost nothing; the next request or
connection wakes it in about a second, where it left off. Turning it on restarts it
once. `enabled: false` makes it always on. Pause is different: a paused service never
wakes by itself until it is resumed.

## Lizard Sandboxes

A sandbox is a Firecracker microVM for running code, separate from app services.
`sandbox_create` takes an explicit project, a finite `lifetimeMs` (default 5 minutes, at
most a day) and `confirm: true`; `template` (default `interpreter`; also `base`, `codex`,
`claude`, `opencode`, `pi`, `prime`, `desktop`) and `size` (`small`, `medium`, `large`)
are optional. It starts in `us-east-1` unless `region` names another; with `volume` or
`snapshotId` it starts in their region. Then `sandbox_write_file`, `sandbox_exec`, `sandbox_read_file` and
`sandbox_list_files` work inside it, and `sandbox_delete` ends it. Every create needs
the user's approval: sandboxes are billed.

- `sandbox_set_timeout` changes how long it lives from now.
- `sandbox_pause` keeps memory, processes and files and stops compute billing;
  `sandbox_resume` continues where it stopped. Prefer pausing over deleting when the
  user may come back.
- `sandbox_snapshot` saves a running sandbox; `sandbox_create` with `snapshotId` starts a
  new one from it (same size). `sandbox_snapshot_list` / `sandbox_snapshot_delete`
  manage them; snapshots are billed for storage.
- `sandbox_fork` starts live copies (memory and processes included). Near a limit only
  some copies may start; report the ones that failed.
- `sandbox_expose_port` gives a port an HTTPS URL (the server must listen on 0.0.0.0).
  The URL carries the port's access token: a browser opens it once and keeps a cookie;
  other clients send `accessToken` as the `X-Lizard-Access-Token` header. Anyone with
  the URL can reach the port, so give it only to the user. `sandbox_unexpose_port`
  removes it.
- A failed, cancelled or timed-out `sandbox_exec` destroys the sandbox, so keep files the
  user needs on a volume or read them back first.

## Persistent volumes

`volume_create` without `service` makes a sandbox volume: mount it with
`sandbox_create`'s `volume` (same region); its files outlive the sandbox. With `service`
it attaches a volume to an app at `mountPath` (default `/data`) and restarts the app.
`volume_resize` only grows a volume (older volumes can shrink if 10% stays free).
`volume_delete` needs `confirm: true` and refuses while a sandbox has it attached; with
`service` it detaches and deletes an app's volume. Delete an app's volume before
`project_delete`: a project in trash keeps its app volumes for 3 days.

## Workspace limits

A workspace owner can cap running sandboxes, CPU, memory and disk
(`workspace_limits_set`; `null` removes a cap). An error with `WORKSPACE_SANDBOX_LIMIT`
or `WORKSPACE_USAGE_LIMIT` fails the same way on retry: read `workspace_limits_get`,
then pause or delete a sandbox, scale a service down, or ask the owner to raise it.
Resellers can show a workspace's scoped keys their own prices with
`workspace_resale_pricing_set`; the owner's bill does not change.

## Domains bought on Lizard

`domain_owned_list` lists domains the user bought on Lizard. `domain_attach` with one of
them (or a subdomain) sets the DNS records itself; if that would replace records that
point elsewhere it refuses and lists them — ask the user, then call again with
`force: true`. `domain_dns_list` / `domain_dns_update` read and change other records
(MX, TXT, redirects). An API key can read these records but not change them; changes
need a client connected with OAuth.

## Lizard Git

Lizard Git (lizard.build/git) is Lizard's own git hosting — not GitHub. `repo_list`,
`repo_show`, `repo_files`, `repo_read_file` and `repo_commits` read repositories;
`repo_create` makes one; `repo_commit` commits files on the server (there is no clone;
pass `expect` to have the server merge if the branch moved, and an `idempotencyKey` to
make a retry safe). `pr_create`, `pr_show`, `pr_list` and `pr_merge` handle pull
requests; `ci_run_list` and `ci_run_show` (with `logs: true`) read CI runs from
`.lizard/workflows`. A commit to a branch a service deploys from starts a deploy.
Lizard Git refuses API keys with scopes. The `git_*` tools are only about a service's
GitHub connection.

## Common tools

```
whoami / workspace_list / project_list / region_list        identity + discovery, no writes
workspace_create / project_create                            new workspace / project
project_delete / workspace_delete                            trash a project (sandboxes go at once) / delete an empty workspace
workspace_limits_get / _set, workspace_resale_pricing_*      caps on what a workspace runs; reseller prices
service_list / service_show                                  services in a project / one service's detail
service_create (repoUrl) / addon_create                      deploy a repo / provision postgres|redis|s3
service_set / service_set_port / service_rename               build/deploy config, port, name
service_scale                                                 replicas / cpu / memory (apps), storage (addons, grow-only)
deploy_redeploy / deploy_restart / deploy_events              rebuild+redeploy / restart / build+pod history
service_pause / service_resume                                stop one app or database without deleting it / start it again
project_pause / project_resume, workspace_pause / _resume     the same for every service of a project / workspace (owner)
service_sleep_status / service_sleep_set                      serverless: sleep when idle (memory saved, ~1 s wake) or always on
logs_tail / metrics_get / billing_summary                     recent logs / cpu+mem+net / cost summary
billing_status                                                plan, trial, credits used this month, Billing link
secrets_list / secrets_set / secrets_delete / secrets_refs    env vars, scoped project-wide or per-service
domain_attach / domain_verify / domain_delete                 custom domain lifecycle
domain_owned_list / domain_dns_list / domain_dns_update       domains bought on Lizard and their DNS records
volume_list / volume_create / volume_resize / volume_delete   persistent volumes for sandboxes and apps
template_list / template_show / template_deploy               deploy a ready-made project from a template
git_checkout / git_status / git_connect                       switch branch / connection status / GitHub App install URL
repo_* / pr_* / ci_run_*                                      Lizard Git repositories, pull requests, CI runs
sandbox_create / _exec / _read_file / _write_file / _delete   run code in a sandbox
sandbox_pause / _resume / _snapshot / _fork / _expose_port    keep, copy and share a sandbox
service_delete                                                permanent, requires confirm:true
config_apply                                                  bulk config-as-code write; can silently overwrite fields verbatim — prefer the narrower tools above for single-field changes
```

## Response format

After an operation, report:

1. What was done — action + scope (which project, which service).
2. Result — IDs, status, the real values from the tool's response.
3. What's next — a read-back to verify, a DNS record the user needs to add, an env-var
   ref template, or confirmation the task is complete.

Skip a call-by-call transcript unless it explains a failure.

## Don't do

1. Don't add a Docker `HEALTHCHECK` expecting the platform to use it — it doesn't run
   Docker's healthcheck loop.
2. Don't set a redundant `startCommand` on the lizardpack auto-detect path —
   `Procfile` (`web:`) and `package.json`'s `scripts.start` are picked up
   automatically there. The moment `buildCommand`/`startCommand` is set at all
   (synthesized-Dockerfile path), neither is read — set `startCommand` explicitly
   there, or rely on the repo's own Dockerfile `CMD`.
3. A Dockerfile that only copies pre-built artifacts (`COPY dist/`, `build/`,
   `.next/`) without a real `RUN` build step gets silently regenerated by lizardpack —
   that's expected, not a bug to work around.
4. Don't generate a Dockerfile unsolicited — lizardpack auto-detects most stacks. Only
   propose writing one if a deploy actually fails without it, and ask first.
5. Don't put runtime secrets (DB credentials, API keys, S3 keys) in project scope "in
   case another service needs it later" — scope to the services that actually consume
   them.
6. Don't fabricate a domain, region code, or any other platform-generated value —
   always resolve it from a tool response (`region_list`, `service_show`,
   `deploy_events`), never guess or predict one.
