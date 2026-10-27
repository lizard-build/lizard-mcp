# Lizard MCP

An MCP server that lets ChatGPT, Claude and other MCP clients deploy and manage apps, run code in Lizard Sandboxes and work with Lizard Git repositories on [Lizard (lizard.build)](https://lizard.build).

Connect it once, then ask your assistant to ship a service, read logs, set secrets, scale replicas, attach a domain, run a script in a sandbox or open a pull request — in plain words.

## Connect a client

The server speaks Streamable HTTP at `POST /mcp`, and stdio for clients that
spawn a local process instead ([below](#run-it-over-stdio)). A hosted instance
runs at:

```
https://employ-woman-g1q2.us-east-1.onlizard.com/mcp
```

Every request carries a bearer token. A client that speaks OAuth gets one
itself — the server advertises where, so there is nothing to paste. Clients
that only send headers use a `liz_` API key instead:

```bash
lizard keys create my-mcp-key
```

The dashboard creates the same thing under **Sandboxes → Get started → New API
key**. Either way the key is shown once.

### Claude Code

```bash
claude mcp add --transport http lizard https://employ-woman-g1q2.us-east-1.onlizard.com/mcp
```

Claude Code runs the OAuth flow on first use. To skip it and use a key:

```bash
claude mcp add --transport http lizard https://employ-woman-g1q2.us-east-1.onlizard.com/mcp \
  --header "Authorization: Bearer liz_your_key"
```

### Cline

Follow [the Cline installation guide](llms-install.md) to connect the hosted
server with a bearer token. Use Cline's `streamableHttp` transport, keep tool
approval on, then check the connection with `whoami`. No local build is needed.

### Cursor and other clients configured by JSON

```json
{
  "mcpServers": {
    "lizard": {
      "url": "https://employ-woman-g1q2.us-east-1.onlizard.com/mcp",
      "headers": { "Authorization": "Bearer liz_your_key" }
    }
  }
}
```

### ChatGPT

ChatGPT connects to a URL and runs OAuth itself — no key to paste. It needs
developer mode and a registered connection; see
[Publishing to Codex / ChatGPT](#publishing-to-codex--chatgpt) below.

### Against a local server

Run it as described in the next section, then use `http://localhost:3000/mcp`
in place of the hosted URL.

### Check the connection

```bash
curl -sS -X POST https://employ-woman-g1q2.us-east-1.onlizard.com/mcp \
  -H "Authorization: Bearer liz_your_key" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Without a token the same call returns `401` and a `WWW-Authenticate` header
pointing at the OAuth metadata. That is the server working, not failing.

## Run it

```bash
npm install
npm run build
npm start
```

For development with reload:

```bash
npm run dev
```

## Run it over stdio

`npm start` serves HTTP. To have a client spawn the server instead, point it at
`dist/stdio.js`:

```json
{
  "mcpServers": {
    "lizard": {
      "command": "node",
      "args": ["/path/to/lizard-mcp/dist/stdio.js"],
      "env": { "LIZARD_TOKEN": "liz_your_key" }
    }
  }
}
```

A spawned process has no browser to run OAuth in, so the token comes from the
environment and binds the process to one user. Without it the server still
starts and lists its tools — calling one then returns a message asking for a
key.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on (HTTP only) |
| `PUBLIC_URL` | `http://localhost:$PORT` | The URL clients reach this server on. Sets the OAuth resource identifier, so it must match the real address in production. |
| `PLATFORM_URL` | `https://lizard.build` | The Lizard API this server talks to |
| `LIZARD_TOKEN` | — | API key for stdio mode, where there is no OAuth handshake. `LIZARD_API_KEY` works too. |

## Tools

| Area | Tools |
|---|---|
| Account | `whoami`, `workspace_list`, `workspace_create`, `workspace_delete`, `project_list`, `project_create`, `project_delete`, `project_pause`, `project_resume`, `workspace_pause`, `workspace_resume`, `region_list`, `billing_status`, `billing_summary` |
| Workspace limits | `workspace_limits_get`, `workspace_limits_set`, `workspace_resale_pricing_get`, `workspace_resale_pricing_set` |
| Services | `service_list`, `service_show`, `service_create`, `service_set`, `service_rename`, `service_delete`, `service_pause`, `service_resume`, `service_sleep_status`, `service_sleep_set`, `service_scale`, `service_get_port`, `service_set_port`, `addon_create` |
| Deploys | `deploy_redeploy`, `deploy_restart`, `deploy_events` |
| Templates | `template_list`, `template_show`, `template_deploy` |
| Logs and metrics | `logs_tail`, `metrics_get` |
| Secrets | `secrets_list`, `secrets_set`, `secrets_delete`, `secrets_refs` |
| Domains | `domain_attach`, `domain_verify`, `domain_delete`, `domain_owned_list`, `domain_dns_list`, `domain_dns_update` |
| Volumes | `volume_list`, `volume_create`, `volume_resize`, `volume_delete` |
| GitHub connection | `git_connect`, `git_checkout`, `git_status` |
| Lizard Git | `repo_list`, `repo_create`, `repo_show`, `repo_delete`, `repo_files`, `repo_read_file`, `repo_commit`, `repo_commits`, `pr_list`, `pr_create`, `pr_show`, `pr_merge`, `ci_run_list`, `ci_run_show` |
| Shell | `ssh_exec` |
| Sandboxes | `sandbox_list`, `sandbox_show`, `sandbox_create`, `sandbox_exec`, `sandbox_read_file`, `sandbox_write_file`, `sandbox_list_files`, `sandbox_delete`, `sandbox_set_timeout`, `sandbox_pause`, `sandbox_resume`, `sandbox_snapshot`, `sandbox_snapshot_list`, `sandbox_snapshot_delete`, `sandbox_fork`, `sandbox_expose_port`, `sandbox_unexpose_port` |
| Config as code | `config_apply` |

Tool names use `snake_case` (not the MCP spec's permitted dots) to match OpenAI's function-name pattern `^[a-zA-Z0-9_-]{1,64}$`, which some ChatGPT/Codex surfaces enforce directly.

Destructive tools — `project_delete`, `workspace_delete`, `service_delete`, `secrets_delete`, `domain_delete`, `volume_delete`, `sandbox_delete`, `sandbox_snapshot_delete`, `repo_delete`, `ssh_exec`, and `domain_dns_update` with `remove` — require an explicit confirmation argument, so a client cannot delete anything or run arbitrary commands by accident.

`project_delete` puts the project's services and databases in trash for 3 days, but deletes its sandboxes, their volumes and snapshots at once.

`billing_status` is read-only: it shows the plan (Pro at $19/month with $19 of usage included each month, the trial, prepaid credits until November 1, 2026, or enterprise) and the Billing link. Starting, paying for and cancelling Pro happen in the browser. When the account has to pay before it can create something, the tool error gives the platform's sentence with the page to open on its last line, and `structuredContent.error` carries the code (`PAYMENT_REQUIRED`), `paymentStatus` and the links.

### What the Lizard CLI has and this server does not

`test/parity/cli-coverage.json` maps every Lizard CLI command to the tools that cover it, or says why none does. The main gaps, on purpose:

- `lizard up` and other commands that read local files: a remote server never sees them. Deploy from a GitHub or Lizard Git repo instead, or commit files with `repo_commit`.
- API keys (`lizard keys`), payments (`lizard billing` changes), agent credentials (`lizard agents`): they handle secrets or money and belong in the browser or a terminal.
- Lizard Git admin (webhooks, branch rules, collaborators, CI secrets and environments, releases, labels, issues): the Lizard CLI and Lizard SDK cover them.
- Interactive tools: sandbox shell, VNC and desktop streams, live log streams.

Bought domains: an API key can read their DNS records but not change them. Changes (`domain_dns_update`, `domain_attach` on a bought domain) need a client connected with OAuth.

### Lizard Git

`repo_*`, `pr_*` and `ci_*` reach Lizard Git (lizard.build/git) with the caller's own token, as `Authorization: Bearer`. Lizard Git refuses API keys with scopes. Every commit is made on the server with `repo_commit`; there is no clone. To deploy a repository, call `service_create` with `repoUrl` set to `lizard:owner/name`. `LIZARD_GIT_URL` points the server at another Lizard Git (default `<PLATFORM_URL>/git`).

## Sandbox workflow

Lizard (lizard.build) provides Lizard Sandboxes for short-lived code execution. These resources are separate from app services. Start with `project_list`, then call `sandbox_create` with the chosen project and `confirm: true`. Keep the returned `sandboxId` for later calls.

```json
{"name":"sandbox_create","arguments":{"project":"YOUR_PROJECT_ID","lifetimeMs":300000,"confirm":true}}
```

Use `sandbox_write_file` to write a script, `sandbox_exec` to run it, and `sandbox_read_file` to read its results. Finish with `sandbox_delete`. Create, execute, write, and delete need the user's approval before the client sets `confirm: true`. The MCP server does not open a confirmation dialog.

Sandboxes use the `interpreter` template and size `small` unless `template` and `size` say otherwise, with `/workspace` as the default path. They expire after five minutes by default; `lifetimeMs` accepts 60,000–86,400,000 milliseconds (a day), and `sandbox_set_timeout` changes it later. Expiry or deletion loses all files except those on an attached volume. Creation uses billed cloud resources. Host files, environment variables, and access tokens stay out of the sandbox.

`sandbox_pause` saves memory, processes and files and stops the sandbox; `sandbox_resume` continues it. `sandbox_snapshot` saves a running sandbox to start new ones from (`sandbox_create` with `snapshotId`), and `sandbox_fork` starts live copies. `sandbox_expose_port` gives a port an HTTPS URL that carries its access token (other clients send it as `X-Lizard-Access-Token`). Pause, resume and snapshot wait up to two minutes for the platform to finish.

Commands run as root within the sandbox, default to a 60-second timeout, and accept up to 120 seconds. Cancellation, timeout, or an uncertain command request destroys the whole sandbox to stop remote work. The `confirm` field covers this loss of files. Use a sandbox created for the task; keep needed files elsewhere first. A normal nonzero exit code preserves the sandbox. Access or input rejection does not delete it. The server never retries commands automatically.

Text reads and writes accept up to 64 KiB of UTF-8. Each output stream is capped at 64 KiB and includes a truncation flag. All paths refer to the sandbox. `sandbox_show` and `sandbox_list` help check an uncertain result before retrying. `sandbox_delete` treats a sandbox that is already gone as a successful no-op.

The HTTP server handles each call with its caller's Bearer token, including OAuth tokens and API keys. It keeps no shared sandbox handles or global SDK credentials. A disconnected client must reconnect to delete its sandbox; its finite lifetime remains the cleanup backstop.

## Auth

The server speaks OAuth 2.1 as an MCP protected resource (RFC 9728). It holds no secrets of its own: every request carries a bearer token, and Lizard decides whether that token is valid. Both OAuth-issued tokens and `liz_` API keys work.

Each request builds a fresh server bound to the caller's token, so one process serves many users without sharing state.

Over stdio there is no OAuth and no per-request token — the key comes from the environment and the process serves one user, as described above.

## Tests

```bash
npm test        # unit and MCP transport tests, docs and CLI parity checks
npm run typecheck
npm run build
npm run audit:cli   # every Lizard CLI command mapped? (needs the CLI on PATH)
```

`npm run audit:live` calls every tool against the real platform: it creates a workspace named `mcp-audit-<time>`, works only inside it, deletes it at the end and writes a report to `audit-report.json`. It needs `LIZARD_TOKEN` (an API key with no scopes) and uses billed resources for about half an hour. Pass `--only sandbox,volume` to run some groups.

To test real sandbox resources, set `LIZARD_API_KEY`, `LIZARD_PROJECT_ID`, and `LIZARD_LIVE_TESTS=1`, then run `npm exec -- vitest run test/live/sandboxes.test.ts`. The test uses stdio MCP to create a sandbox, run shell and file tools, check timeout cleanup, and delete it. It uses billed resources; it does not deploy the MCP server.

`test/manual/mcp-inspector.md` covers end-to-end checks against a stub platform and a live one.

## Deployed instance

This server itself runs as a Lizard app: `lizard-mcp` in mikelun's workspace,
deployed straight from this repo (git-source, auto-redeploys on push to `main`).

```
https://employ-woman-g1q2.us-east-1.onlizard.com/mcp
```

`PUBLIC_URL` is set on that service to match, so `allowedHosts`/OAuth resource
metadata line up with the real domain — see `src/index.ts`.

## Publishing to Codex / ChatGPT

`.codex-plugin/plugin.json` is in place. This is a hosted remote MCP server (not
a bundled stdio one), so it's wired via `.app.json` + a registered connection,
not `.mcp.json`. That last step needs a human in a real ChatGPT session — it
isn't scriptable:

1. In ChatGPT: **Settings → Security and login → Developer mode** (turn it on).
2. Go to [ChatGPT Plugins](https://chatgpt.com/plugins) → **+** → enter the MCP
   server URL above → complete the connection.
3. Copy the resulting `plugin_asdk_app_...` ID from the browser URL.
4. Add `.app.json` at the repo root:
   ```json
   { "app": { "id": "plugin_asdk_app_..." } }
   ```
5. Add `"apps": "./.app.json"` to `.codex-plugin/plugin.json`.
6. Test locally via a marketplace entry (`@plugin-creator`, or hand-write
   `~/.agents/plugins/marketplace.json`), then submit through the
   [plugin submission portal](https://developers.openai.com/plugins/deploy/submission)
   for public review.

## License

MIT
