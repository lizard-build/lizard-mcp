# Manual verification

Automated tests (`npm test`) cover pure logic: resolution, scale/domain validation. They don't exercise the real HTTP/auth wiring end-to-end, since that requires a live dragonlabs-platform (Postgres, GitHub OAuth app credentials) to actually issue a token. This doc covers both:
(a) a self-contained smoke test using a tiny stub in place of dragonlabs-platform (no external dependencies, proves lizard-mcp's own wiring is correct), and
(b) the real end-to-end flow against an actual running platform, once one is available.

## (a) Self-contained smoke test (no live platform needed)

Stand up a throwaway Node http server that answers just enough of dragonlabs-platform's API for lizard-mcp to boot and serve a few tool calls:

```js
// /tmp/fake-platform.mjs
import http from "node:http";
const TOKEN = "test-token-123";
http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/.well-known/oauth-authorization-server") return send(200, {
    issuer: "http://localhost:4001", authorization_endpoint: "http://localhost:4001/oauth/authorize",
    token_endpoint: "http://localhost:4001/oauth/token", response_types_supported: ["code"],
  });
  if (req.url === "/api/auth/me") {
    return (req.headers.authorization === `Bearer ${TOKEN}`)
      ? send(200, { id: "u1", username: "testuser" })
      : send(401, { error: "Not authenticated" });
  }
  if (req.url?.startsWith("/api/projects")) return send(200, [{ id: "p1", name: "demo", slug: "demo", workspaceId: "w1" }]);
  send(404, { error: "not found in stub" });
}).listen(4001, () => console.log("stub listening on :4001"));
```

```bash
node /tmp/fake-platform.mjs &
PLATFORM_URL=http://localhost:4001 PORT=4000 PUBLIC_URL=http://localhost:4000 npm run dev &
```

Then drive it with curl:

```bash
# Discovery — NOTE the metadata path mirrors the resource sub-path (RFC 9728),
# it is NOT the bare /.well-known/oauth-protected-resource. Getting this
# wrong once already broke the WWW-Authenticate challenge during development
# — always compute it via the SDK's getOAuthProtectedResourceMetadataUrl(),
# never hand-construct it.
curl http://localhost:4000/.well-known/oauth-protected-resource/mcp

# Unauthenticated — expect 401 with a WWW-Authenticate header pointing at
# the URL above
curl -i -X POST http://localhost:4000/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Authenticated — full handshake + tool list
curl -X POST http://localhost:4000/mcp \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.1"}}}'

curl -X POST http://localhost:4000/mcp \
  -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

Last run of this exact sequence (2026-07-21) confirmed: discovery metadata correct, unauthenticated request gets a spec-compliant 401 + `WWW-Authenticate`, authenticated `initialize`/`tools/list`/`tools/call` all succeed, and a resolution error (nonexistent project) comes back as a clean `isError: true` result rather than a crash.

## (b) Real end-to-end, against a live dragonlabs-platform

Requires actually running dragonlabs-platform (Postgres + `JWT_SECRET` + a real GitHub OAuth App for login) and lizard-client's consent page — this is the OAuth 2.1 work from the prior session, not part of this repo. Once that's running:

1. Start dragonlabs-platform and lizard-client locally (see their own repos' verification docs).
2. Start `lizard-mcp` with `PLATFORM_URL` pointed at that local platform instance.
3. In a browser, hit `{PLATFORM_URL}/oauth/authorize?...` with a CIMD client (see dragonlabs-platform's OAuth plan for how to stand up a test CIMD document), complete the consent screen, and capture the resulting access token from the `/oauth/token` exchange.
4. Use that real token in place of `test-token-123` above, either via `@modelcontextprotocol/inspector` (`npx @modelcontextprotocol/inspector`, point it at `http://localhost:$PORT/mcp`) or the same raw curl commands.
5. Try a real mutating tool (e.g. `service.list` against a real project) to confirm the token round-trips correctly through `ctx.api` all the way to dragonlabs-platform's actual database.
