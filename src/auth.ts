import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

const PLATFORM_URL = process.env.PLATFORM_URL || "https://lizard.build";

/**
 * Reads the `exp` claim out of a JWT's payload without verifying its
 * signature — safe because a JWT payload is only base64url-encoded, not
 * encrypted, so this needs no shared secret. Returns null for non-JWT
 * tokens (e.g. a legacy liz_ API key) or a payload with no exp claim.
 * Actual validity is still decided entirely by /api/auth/me below; this
 * only supplies the informational expiresAt field the SDK's bearer-auth
 * middleware requires on every AuthInfo.
 */
function readJwtExpirySeconds(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof decoded.exp === "number" ? decoded.exp : null;
  } catch {
    return null;
  }
}

/**
 * Verifies an access token by asking dragonlabs-platform whether it's valid —
 * never verifies the JWT's signature itself (see readJwtExpirySeconds for the
 * one thing it does read). This keeps lizard-mcp a dumb pass-through with
 * zero shared secrets (no JWT_SECRET needs to exist here); token validity has
 * exactly one source of truth: dragonlabs-platform's own /api/auth/me, which
 * already accepts both liz_ API keys and OAuth-issued JWTs with no backend
 * changes needed.
 */
export const tokenVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const res = await fetch(`${PLATFORM_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Token verification failed: ${res.status}`);
    }
    let body: { id: string; username: string };
    try {
      body = (await res.json()) as { id: string; username: string };
    } catch {
      throw new Error("Token verification failed: /api/auth/me returned a non-JSON response");
    }
    // Fall back to a short synthetic expiry for non-JWT tokens (e.g. liz_ API
    // keys) — harmless, since every tool call re-verifies against
    // /api/auth/me anyway rather than trusting this value for caching.
    const expiresAt = readJwtExpirySeconds(token) ?? Math.floor(Date.now() / 1000) + 300;
    return {
      token,
      clientId: "chatgpt",
      scopes: ["mcp"],
      expiresAt,
      extra: { userId: body.id, username: body.username },
    };
  },
};

/**
 * Fetches dragonlabs-platform's authorization-server metadata once at
 * startup, passed straight through to mcpAuthMetadataRouter. Failure here is
 * fatal — lizard-mcp cannot serve without a reachable authorization server.
 */
export async function fetchAuthorizationServerMetadata(): Promise<OAuthMetadata> {
  const res = await fetch(`${PLATFORM_URL}/.well-known/oauth-authorization-server`);
  if (!res.ok) {
    throw new Error(`Failed to fetch AS metadata from ${PLATFORM_URL}: ${res.status}`);
  }
  return res.json() as Promise<OAuthMetadata>;
}
