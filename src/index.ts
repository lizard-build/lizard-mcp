import type { Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { getServer } from "./server.js";
import { tokenVerifier, fetchAuthorizationServerMetadata } from "./auth.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const MCP_ENDPOINT = new URL(`${PUBLIC_URL}/mcp`);
// Per RFC 9728, when the protected resource lives at a sub-path (not the
// bare origin), its metadata document path mirrors that sub-path — NOT a
// fixed "/.well-known/oauth-protected-resource". Must use the SDK's own
// helper rather than hand-constructing this, or the URL lizard-mcp
// advertises in its own WWW-Authenticate header 404s (caught by manual
// smoke-testing against a stub platform — see test/manual/mcp-inspector.md).
const RESOURCE_METADATA_URL = getOAuthProtectedResourceMetadataUrl(MCP_ENDPOINT);

async function main() {
  // Fail fast if dragonlabs-platform (the authorization server) isn't
  // reachable at boot — lizard-mcp cannot serve without it.
  const oauthMetadata = await fetchAuthorizationServerMetadata();

  const app = createMcpExpressApp();

  // Public discovery route — no auth required to fetch it. A client needs
  // this BEFORE it has a token, to learn where to go get one.
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: MCP_ENDPOINT,
      scopesSupported: ["mcp"],
      resourceName: "Lizard",
    }),
  );

  // Protected tool-invocation route. requireBearerAuth runs first, verifies
  // the token against dragonlabs-platform's /api/auth/me (see auth.ts) and
  // populates req.auth; a fresh, stateless McpServer is built per request,
  // bound to that caller's token.
  app.post(
    "/mcp",
    requireBearerAuth({ verifier: tokenVerifier, resourceMetadataUrl: RESOURCE_METADATA_URL }),
    async (req, res) => {
      const server = getServer(req.auth!.token);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error("Error handling MCP request:", err);
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
        }
      }
    },
  );

  // Stateless mode has no session to resume (GET) or close (DELETE).
  const methodNotAllowed = (_req: unknown, res: Response) => {
    res.writeHead(405).end(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
    );
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.listen(PORT, () => console.log(`lizard-mcp listening on :${PORT}`));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
