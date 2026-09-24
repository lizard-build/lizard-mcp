import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type Call = { method: string; url: string; body?: any; auth?: string };
type Reply = { status?: number; body?: unknown };
let platform: Server;
let platformUrl: string;
let mcpUrl: string;
let httpProcess: ChildProcess;
let client: Client;
let httpClient: Client;
let calls: Call[] = [];
let reply: (call: Call) => Reply;
let authStatus = 200;
const project = { id: 'p1', name: 'demo', slug: 'demo', workspaceId: 'w1' };
const services = { apps: [{ id: 'a1', name: 'web' }], addons: [] };
const env = () => ({ ...process.env, PLATFORM_URL: platformUrl, LIZARD_TOKEN: 'liz_fixture' }) as Record<string, string>;
const makeClient = () => new Client({ name: 'lizard-protocol-test', version: '1' });
const invoke = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const texts = (result: any) => result.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
const writes = () => calls.filter((call) => call.method !== 'GET');

beforeAll(async () => {
  platform = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const call: Call = { method: req.method!, url: req.url!, auth: req.headers.authorization, ...(raw ? { body: JSON.parse(raw) } : {}) };
    let result: Reply;
    if (req.url === '/.well-known/oauth-authorization-server') {
      result = { body: { issuer: platformUrl, authorization_endpoint: `${platformUrl}/authorize`, token_endpoint: `${platformUrl}/token`, response_types_supported: ['code'] } };
    } else if (req.url === '/api/auth/me') {
      result = { status: authStatus, body: authStatus === 200 ? { id: 'u1', username: 'fixture' } : { error: 'Fixture auth failure' } };
    } else {
      calls.push(call);
      if (call.url === '/api/projects' && call.method === 'GET') result = { body: [project] };
      else if (call.url === '/api/projects/p1/services?workspaceId=w1') result = { body: services };
      else result = reply(call);
    }
    res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(result.status === 204 ? undefined : JSON.stringify(result.body ?? {}));
  });
  platform.listen(0, '127.0.0.1');
  await once(platform, 'listening');
  platformUrl = `http://127.0.0.1:${(platform.address() as any).port}`;
  // Reserve an unused loopback port before starting the real HTTP entry point.
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = (portProbe.address() as any).port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
  httpProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(), env: { ...env(), PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP server did not start')), 10000);
    httpProcess.once('exit', (code) => { clearTimeout(timer); reject(new Error(`HTTP server exited ${code}`)); });
    httpProcess.stdout!.on('data', (data) => { if (String(data).includes('listening')) { clearTimeout(timer); resolve(); } });
  });
  client = makeClient();
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/stdio.ts'], cwd: process.cwd(), env: env(), stderr: 'pipe' }));
  httpClient = makeClient();
  await httpClient.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: 'Bearer liz_http_fixture' } } }));
}, 20000);

afterAll(async () => {
  await client?.close();
  await httpClient?.close();
  if (httpProcess && httpProcess.exitCode === null) { httpProcess.kill(); await once(httpProcess, 'exit'); }
  await new Promise<void>((resolve) => platform?.close(() => resolve()));
});
beforeEach(() => { calls = []; authStatus = 200; reply = () => ({ body: { ok: true } }); });

describe('real MCP transports against a local REST fixture', () => {
  it('lists the same 38 tools over stdio and HTTP', async () => {
    const stdio = await client.listTools();
    const http = await httpClient.listTools();
    expect(stdio.tools.map((tool) => tool.name).sort()).toEqual(http.tools.map((tool) => tool.name).sort());
    expect(stdio.tools).toHaveLength(38);
    for (const name of ['workspace_create', 'project_delete', 'template_list', 'template_show', 'template_deploy']) {
      expect(stdio.tools.find((tool) => tool.name === name)?.description).toBeTruthy();
    }
    expect(stdio.tools.find((tool) => tool.name === 'project_delete')?.annotations?.destructiveHint).toBe(true);
  });
  it('creates a workspace and project with the chosen scope', async () => {
    await invoke('workspace_create', { name: 'Demo' });
    await invoke('project_create', { name: 'demo', workspaceId: 'w1' });
    expect(writes()).toEqual([
      { method: 'POST', url: '/api/workspaces', auth: 'Bearer liz_fixture', body: { name: 'Demo' } },
      { method: 'POST', url: '/api/projects', auth: 'Bearer liz_fixture', body: { name: 'demo', workspaceId: 'w1' } },
    ]);
  });
  it('deploys a repo without inventing a domain before build completion', async () => {
    reply = () => ({ body: { id: 'a1', status: 'building', domain: null } });
    const result = await invoke('service_create', { project: 'demo', name: 'web', region: 'eu', repoUrl: 'https://github.com/example/app' });
    expect(result.structuredContent).toMatchObject({ domain: null, status: 'building' });
    expect(writes()[0]).toMatchObject({ url: '/api/projects/p1/apps?workspaceId=w1', body: { name: 'web', region: 'eu', repoUrl: 'https://github.com/example/app' } });
  });
  it.each(['postgres', 'redis', 's3'])('creates %s in the requested region', async (type) => {
    expect((await invoke('addon_create', { project: 'p1', name: type, type, region: 'eu' })).isError).not.toBe(true);
    expect(writes()[0]).toMatchObject({ url: '/api/projects/p1/addons?workspaceId=w1', body: { type, name: type, region: 'eu' } });
  });
  it('lists private templates, reads one, and deploys it with variables', async () => {
    await invoke('template_list', { mine: true });
    await invoke('template_show', { template: 'a/b' });
    await invoke('template_deploy', { template: 'a/b', workspaceId: 'w1', projectName: 'copy', placeholderValues: { MODE: 'test' } });
    expect(calls.map((call) => call.url)).toEqual(['/api/templates?mine=1', '/api/templates/a%2Fb', '/api/templates/a%2Fb/deploy']);
    expect(writes()[0].body).toEqual({ workspaceId: 'w1', projectName: 'copy', placeholderValues: { MODE: 'test' } });
  });
  it('reports partial template failure and preserves the project for cleanup', async () => {
    reply = () => ({ body: { projectId: 'partial', projectSlug: 'partial', errors: ['database could not start'] } });
    const result = await invoke('template_deploy', { template: 'demo', workspaceId: 'w1', projectName: 'copy' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ projectId: 'partial', errors: ['database could not start'] });
    expect(writes()).toHaveLength(1);
  });
  it('requires explicit project-delete confirmation before any request', async () => {
    expect((await invoke('project_delete', { project: 'p1' })).isError).toBe(true);
    expect((await invoke('project_delete', { project: 'p1', confirm: false })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it('returns valid MCP content for a 204 delete response', async () => {
    reply = () => ({ status: 204 });
    const result = await invoke('project_delete', { project: 'demo', confirm: true });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(texts(result))).toEqual({ ok: true });
    expect(writes()[0]).toMatchObject({ method: 'DELETE', url: '/api/projects/p1?workspaceId=w1' });
  });
  it('masks secrets by default and forwards service-scoped addon references', async () => {
    reply = () => ({ body: [{ key: 'PASSWORD', value: 'fixture-private-value' }] });
    const result = await invoke('secrets_list', { project: 'p1', service: 'web' });
    expect(JSON.stringify(result)).not.toContain('fixture-private-value');
    expect(texts(result)).toContain('***');
    reply = () => ({ body: { revision: 1 } });
    await invoke('secrets_set', { project: 'p1', service: 'web', values: { DATABASE_URL: '${{postgres.DATABASE_URL}}' } });
    expect(writes()[0].body).toEqual({ secrets: { services: { web: { DATABASE_URL: '${{postgres.DATABASE_URL}}' } } } });
  });
  it('keeps the two HTTP callers tokens separate', async () => {
    await httpClient.callTool({ name: 'workspace_list', arguments: {} });
    await invoke('workspace_list');
    expect(calls.map((call) => call.auth)).toEqual(['Bearer liz_http_fixture', 'Bearer liz_fixture']);
  });
  it('returns API errors as tool errors without a stack trace', async () => {
    reply = () => ({ status: 409, body: { error: 'Name already taken' } });
    const result = await invoke('workspace_create', { name: 'demo' });
    expect(result.isError).toBe(true);
    expect(texts(result)).toBe('Name already taken');
  });
  it('allows discovery without a stdio token and explains auth when calling a tool', async () => {
    const anonymous = makeClient();
    try {
      await anonymous.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/stdio.ts'], cwd: process.cwd(), env: { ...env(), LIZARD_TOKEN: '', LIZARD_API_KEY: '' }, stderr: 'pipe' }));
      expect((await anonymous.listTools()).tools).toHaveLength(38);
      expect(texts(await anonymous.callTool({ name: 'whoami', arguments: {} }))).toContain('No Lizard API key');
    } finally { await anonymous.close(); }
  });
  it.each([401, 403])('turns platform auth %s into a 401 OAuth challenge', async (status) => {
    authStatus = status;
    const response = await fetch(mcpUrl, { method: 'POST', headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('invalid_token');
    const metadataUrl = response.headers.get('www-authenticate')!.match(/resource_metadata="([^"]+)"/)![1];
    expect((await fetch(metadataUrl)).status).toBe(200);
  });
  it('rejects an expired JWT even if the upstream user lookup succeeds', async () => {
    const expired = `e30.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`;
    const response = await fetch(mcpUrl, { method: 'POST', headers: { Authorization: `Bearer ${expired}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
  });
  it('keeps upstream outages distinct from invalid credentials', async () => {
    authStatus = 503;
    const response = await fetch(mcpUrl, { method: 'POST', headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(500);
  });
});
