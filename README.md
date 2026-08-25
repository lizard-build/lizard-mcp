# Lizard MCP

An MCP server that lets ChatGPT, Claude and other MCP clients deploy and manage apps on [Lizard (lizard.build)](https://lizard.build).

Connect it once, then ask your assistant to ship a service, read logs, set secrets, scale replicas or attach a domain — in plain words.

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

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `PUBLIC_URL` | `http://localhost:$PORT` | The URL clients reach this server on. Sets the OAuth resource identifier, so it must match the real address in production. |
| `PLATFORM_URL` | `https://lizard.build` | The Lizard API this server talks to |

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
