---
name: lizard-deploy
description: Deploy and manage apps, databases, and infra on Lizard (lizard.build) — deploying a GitHub repo, provisioning a Postgres/Redis/S3 addon, reading logs/metrics, managing secrets, scaling, attaching domains, or running a one-off shell command in a service. Trigger this whenever the user asks to ship, deploy, scale, or manage anything on Lizard, or mentions a Lizard project/service/addon by name.
---

# Lizard deploy

Lizard is a PaaS: deploy GitHub repos as containerized apps, provision managed
Postgres/Redis/S3 addons, and manage them (logs, metrics, secrets, domains, scaling,
shell exec) — scoped to the authenticated user's own workspaces and projects.

## Mental model

workspace -> project -> service (app or addon)

Most tools take a "project" (name/slug/ID) and a "service" (name/ID) param. If unsure
which project/service the user means, call `workspace_list` / `project_list` /
`service_list` first rather than guessing — resolution is by exact name match, not
fuzzy.

## Domains — do not guess a hostname

Every app is assigned a `*.onlizard.com` domain automatically, but not until its build
finishes and it boots — this can take anywhere from seconds to a few minutes. The
`domain` field is null until then, on `service_create`'s response and on `service_show`
alike. A null/empty domain right after creating or redeploying a service is normal, not
an error — it does NOT mean a domain wasn't assigned, only that it isn't assigned *yet*.

Never fabricate, guess, or predict what the hostname will look like, even as a
placeholder — a plausible-looking fake domain is worse than no domain, because the user
may try to use it. If the user asks for the domain right after a deploy and it's still
null, say the deploy is still in progress and the domain will be available once it
finishes; poll `service_show` or `deploy_events` and report back the real value once
`domain` is actually non-null. Only call `domain_attach` when the user explicitly wants
to bring their own custom domain (pass hostname), or when `service_show` shows no domain
after the deploy has actually finished — e.g. the service was created with
`skipInitialDeploy` and never deployed.

## Regions — do not guess a code

Region codes are opaque platform identifiers, not something to infer from a place name.
Call `region_list` before `service_create` or `addon_create` if you don't already know a
valid code from earlier in the conversation.

## Secrets: scope and precedence

Two scopes: project-wide ("global", omit the service param) and per-service (pass
service). Default to service-scope — global exposes the value to every service in the
project, including ones that don't need it. Only use global for genuinely non-secret,
provably-shared values (log level, NODE_ENV, feature flags).

Precedence (last wins): addon-issued env < project secrets < project env < app env <
app secrets < platform vars. Platform vars (service name, project ID, PORT, public
domain) are last and cannot be overridden.

Check `secrets_list` before `secrets_set`/`secrets_delete` to avoid creating a duplicate
key or silently shadowing one at a different scope.

## Referencing an addon from a service

Addons don't get separate credentials handed to the user — a consuming service
references the addon's env vars via `${{<addon-name>.<KEY>}}` in its own secrets (set
with `secrets_set`), resolved at deploy time. Use `secrets_refs` to see exactly which
addon/key combinations are available in a project before wiring a reference. A ref to a
missing addon or key silently resolves to an empty string rather than failing the
deploy — after wiring one, it's worth confirming the consumer actually received a value
(e.g. via `logs_tail` or `ssh_exec`) rather than assuming success.

## What triggers a rebuild vs. just a restart

- `deploy_redeploy`, `git_checkout`, or a push to the tracked branch: full rebuild.
- `service_set` on build-affecting fields (repoUrl, branch, sourceType, buildCommand,
  dockerfilePath, rootDirectory): auto-rebuilds — do not also call `deploy_redeploy`
  right after, that queues a redundant second build.
- `service_set` on runtime-only fields (startCommand, preDeployCommand, containerPort,
  watchPatterns): no auto-rebuild — follow with `deploy_redeploy` to apply.
- `secrets_set` / `secrets_delete`: applied live, service restarts to pick them up, no
  rebuild needed.

## Writes are immediate and real

There is no separate platform-side confirmation step — a tool call is the action.
Destructive tools (`service_delete`, `secrets_delete`, `domain_delete`, `ssh_exec`,
`config_apply`) require `confirm:true` in the call itself since there's no interactive
prompt in MCP; still get the user's explicit go-ahead in conversation before setting it.
`ssh_exec` runs arbitrary shell commands inside the service's container — only use it
for commands the user would recognize and approve, and only against the user's own
Lizard-hosted services, never an external machine.

## Composition

Chain the calls a request implies and return one result, not a call-by-call narration.
E.g. "deploy this repo" -> resolve/create project -> `service_create` with repoUrl ->
report the assigned domain once it's ready (poll if needed, never guess it early). "Add a
database" -> `addon_create` -> tell the user the `${{name.KEY}}` refs available (from
`secrets_refs`) rather than raw credentials.
