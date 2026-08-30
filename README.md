# Lizard MCP

An MCP server that lets ChatGPT, Claude and other MCP clients deploy and manage apps on [Lizard (lizard.build)](https://lizard.build).

Connect it once, then ask your assistant to ship a service, read logs, set secrets, scale replicas or attach a domain — in plain words.

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
| Account | `whoami`, `workspace_list`, `project_list`, `project_create`, `region_list`, `billing_summary` |
| Services | `service_list`, `service_show`, `service_create`, `service_set`, `service_rename`, `service_delete`, `service_scale`, `service_get_port`, `service_set_port`, `addon_create` |
| Deploys | `deploy_redeploy`, `deploy_restart`, `deploy_events` |
| Logs and metrics | `logs_tail`, `metrics_get` |
| Secrets | `secrets_list`, `secrets_set`, `secrets_delete`, `secrets_refs` |
| Domains | `domain_attach`, `domain_verify`, `domain_delete` |
| Git | `git_connect`, `git_checkout`, `git_status` |
| Shell | `ssh_exec` |
| Config as code | `config_apply` |

Tool names use `snake_case` (not the MCP spec's permitted dots) to match OpenAI's function-name pattern `^[a-zA-Z0-9_-]{1,64}$`, which some ChatGPT/Codex surfaces enforce directly.

Destructive tools — `service_delete`, `secrets_delete`, `domain_delete`, `ssh_exec` — require an explicit confirmation argument, so a client cannot delete anything or run arbitrary commands by accident.

## Auth

The server speaks OAuth 2.1 as an MCP protected resource (RFC 9728). It holds no secrets of its own: every request carries a bearer token, and Lizard decides whether that token is valid. Both OAuth-issued tokens and `liz_` API keys work.

Each request builds a fresh server bound to the caller's token, so one process serves many users without sharing state.

Over stdio there is no OAuth and no per-request token — the key comes from the environment and the process serves one user, as described above.

## Tests

```bash
npm test        # unit tests
npm run typecheck
```

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
