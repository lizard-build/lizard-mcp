import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApiClient, type ApiClient } from "./lib/api.js";
import { registerAccountTools } from "./tools/account.js";
import { registerServiceTools } from "./tools/services.js";
import { registerDeployTools } from "./tools/deploy.js";
import { registerLogsTools } from "./tools/logs.js";
import { registerMetricsTools } from "./tools/metrics.js";
import { registerSecretsTools } from "./tools/secrets.js";
import { registerDomainTools } from "./tools/domains.js";
import { registerGitTools } from "./tools/git.js";
import { registerSshTools } from "./tools/ssh.js";
import { registerConfigTools } from "./tools/config.js";

export interface ToolContext {
  api: ApiClient;
  /** The raw access token, for the handful of tools (logs.tail build mode,
   *  ssh.exec) that need to make their own SSE requests instead of going
   *  through ctx.api's plain JSON request/response shape. */
  accessToken: string;
}

const INSTRUCTIONS =
  "Lizard is a PaaS: deploy GitHub repos as containerized apps, provision managed " +
  "Postgres/Redis/S3 addons, and manage them (logs, metrics, secrets, domains, scaling, " +
  "shell exec) — scoped to the authenticated user's own workspaces and projects. Most " +
  "tools take a project name/slug/ID and a service name/ID; call workspace.list or " +
  "project.list first if unsure which project the user means. Writes apply immediately " +
  "to real infrastructure, with no separate platform-side confirmation — delete tools " +
  "require confirm:true, and ssh.exec runs arbitrary shell commands the user should trust.";

/**
 * Builds one McpServer + one ToolContext per request, bound to the calling
 * user's access token. lizard-mcp is a stateless multi-tenant service (see
 * lib/api.ts), so nothing here is cached or reused across requests.
 */
export function getServer(accessToken: string): McpServer {
  const server = new McpServer({ name: "lizard", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const ctx: ToolContext = { api: createApiClient(accessToken), accessToken };

  registerAccountTools(server, ctx);
  registerServiceTools(server, ctx);
  registerDeployTools(server, ctx);
  registerLogsTools(server, ctx);
  registerMetricsTools(server, ctx);
  registerSecretsTools(server, ctx);
  registerDomainTools(server, ctx);
  registerGitTools(server, ctx);
  registerSshTools(server, ctx);
  registerConfigTools(server, ctx);

  return server;
}
