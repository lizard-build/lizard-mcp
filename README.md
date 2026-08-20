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
| Account | `whoami`, `workspace.list`, `project.list`, `project.create`, `region.list`, `billing.summary` |
| Services | `service.list`, `service.show`, `service.create`, `service.set`, `service.rename`, `service.delete`, `service.scale`, `service.getPort`, `service.setPort`, `addon.create` |
| Deploys | `deploy.redeploy`, `deploy.restart`, `deploy.events` |
| Logs and metrics | `logs.tail`, `metrics.get` |
| Secrets | `secrets.list`, `secrets.set`, `secrets.delete`, `secrets.refs` |
| Domains | `domain.attach`, `domain.verify`, `domain.delete` |
| Git | `git.connect`, `git.checkout`, `git.status` |
| Shell | `ssh.exec` |
| Config as code | `config.apply` |

Destructive tools — `service.delete`, `secrets.delete`, `domain.delete` — require an explicit confirmation argument, so a client cannot delete anything by accident.

## Auth

The server speaks OAuth 2.1 as an MCP protected resource (RFC 9728). It holds no secrets of its own: every request carries a bearer token, and Lizard decides whether that token is valid. Both OAuth-issued tokens and `liz_` API keys work.

Each request builds a fresh server bound to the caller's token, so one process serves many users without sharing state.

## Tests

```bash
npm test        # unit tests
npm run typecheck
```

`test/manual/mcp-inspector.md` covers end-to-end checks against a stub platform and a live one.

## License

MIT
