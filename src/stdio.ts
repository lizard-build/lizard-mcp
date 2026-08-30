import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getServer } from "./server.js";

/**
 * stdio entry point, for clients that spawn a local process instead of
 * calling the hosted server over HTTP (see index.ts for that one).
 *
 * There is no OAuth handshake over stdio — a spawned process has no browser
 * and no redirect URI to come back to — so the token comes from the
 * environment and binds the whole process to one user. That is the opposite
 * of the HTTP path, which is stateless and multi-tenant, and it is why the
 * two entry points cannot be merged.
 *
 * The token is deliberately not required at startup: tools are registered
 * statically, so tools/list answers without one, and a directory or inspector
 * can introspect the server with nothing to hand. Calling a tool without a
 * token fails with a clear message (see lib/api.ts).
 *
 * stdout carries JSON-RPC frames and nothing else — every message here goes
 * to stderr, or the client's parser breaks.
 */
async function main() {
  const accessToken = process.env.LIZARD_TOKEN || process.env.LIZARD_API_KEY || "";
  if (!accessToken) {
    console.error(
      "lizard-mcp: no LIZARD_TOKEN set. Tools are listed, but calling one fails until you set a key (`lizard keys create`).",
    );
  }

  const server = getServer(accessToken);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
