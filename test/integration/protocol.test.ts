import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type Call = { method: string; url: string; body?: any; auth?: string };
type Reply = { status?: number; body?: unknown; text?: string };
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
    } else if (req.url === '/git/api/session') {
      result = { body: { login: 'fixture' } };
    } else {
      calls.push(call);
      if (call.url === '/api/projects' && call.method === 'GET') result = { body: [project] };
      else if (call.url === '/api/projects/p1/services?workspaceId=w1') result = { body: services };
      else result = reply(call);
    }
    res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(result.status === 204 ? undefined : result.text ?? JSON.stringify(result.body ?? {}));
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
  it('lists the same 90 tools over stdio and HTTP', async () => {
    const stdio = await client.listTools();
    const http = await httpClient.listTools();
    expect(stdio.tools.map((tool) => tool.name).sort()).toEqual(http.tools.map((tool) => tool.name).sort());
    expect(stdio.tools).toHaveLength(90);
    for (const name of ['workspace_create', 'project_delete', 'template_list', 'template_show', 'template_deploy', 'billing_status', 'service_pause', 'service_resume', 'project_pause', 'project_resume', 'workspace_pause', 'workspace_resume', 'service_sleep_status', 'service_sleep_set']) {
      expect(stdio.tools.find((tool) => tool.name === name)?.description).toBeTruthy();
    }
    expect(stdio.tools.find((tool) => tool.name === 'project_delete')?.annotations?.destructiveHint).toBe(true);
    expect(stdio.tools.find((tool) => tool.name === 'billing_status')?.annotations?.readOnlyHint).toBe(true);
    expect(stdio.tools.find((tool) => tool.name === 'sandbox_read_file')?.annotations?.readOnlyHint).toBe(true);
    expect(stdio.tools.find((tool) => tool.name === 'sandbox_exec')?.annotations?.destructiveHint).toBe(true);
  });
  it('requires sandbox confirmation and rejects IDs and oversized text before requests', async () => {
    for (const [name, args] of [
      ['sandbox_create', { project: 'demo' }],
      ['sandbox_exec', { sandboxId: 's1', command: 'ls' }],
      ['sandbox_delete', { sandboxId: 's1' }],
      ['sandbox_show', { sandboxId: '../other' }],
      ['sandbox_write_file', { sandboxId: 's1', path: 'x', content: '🦎'.repeat(20000), confirm: true }],
    ] as const) {
      expect((await invoke(name, args)).isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });
  it('creates a finite sandbox in the resolved project without injecting credentials', async () => {
    reply = () => ({ body: { sandboxId: 's1' } });
    const result = await invoke('sandbox_create', { project: 'demo', confirm: true });
    expect(result.isError).not.toBe(true);
    expect(writes()).toEqual([{ method: 'POST', url: '/api/sandboxes', auth: 'Bearer liz_fixture', body: {
      template: 'interpreter', size: 'small', timeoutMs: 300000, projectId: 'p1', region: 'us-east-1', metadata: { integration: 'lizard-mcp' },
    } }]);
    expect(texts(result)).not.toContain('liz_fixture');
  });
  it('asks again without a region when new sandboxes in the default one are paused', async () => {
    const paused = { status: 503, body: { error: 'New sandboxes are not available in US East (Virginia).', code: 'region_unavailable' } };
    let n = 0;
    reply = () => (n++ === 0 ? paused : { body: { sandboxId: 's1' } });
    expect((await invoke('sandbox_create', { project: 'demo', confirm: true })).isError).not.toBe(true);
    expect(writes().map((w) => w.body.region)).toEqual(['us-east-1', undefined]);
    calls = [];
    reply = () => paused;
    expect((await invoke('sandbox_create', { project: 'demo', region: 'us-east-1', confirm: true })).isError).toBe(true);
    expect(writes()).toHaveLength(1);
  });
  it('keeps sandbox credentials separate for concurrent MCP clients', async () => {
    reply = call => ({ body: { sandboxId: call.url.split('/').at(-1) } });
    await Promise.all([
      invoke('sandbox_show', { sandboxId: 'stdio-sandbox' }),
      httpClient.callTool({ name: 'sandbox_show', arguments: { sandboxId: 'http-sandbox' } }),
    ]);
    expect(calls.find(call => call.url === '/api/sandboxes/stdio-sandbox')?.auth).toBe('Bearer liz_fixture');
    expect(calls.find(call => call.url === '/api/sandboxes/http-sandbox')?.auth).toBe('Bearer liz_http_fixture');
  });
  it('passes an OAuth caller token through as Bearer for sandbox tools', async () => {
    const oauth = makeClient();
    await oauth.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: 'Bearer oauth_fixture' } } }));
    reply = () => ({ body: { stdout: 'ok', stderr: '', exitCode: 0 } });
    try {
      const result = await oauth.callTool({ name: 'sandbox_exec', arguments: { sandboxId: 's1', command: 'echo ok', confirm: true } });
      expect(result.isError).not.toBe(true);
      expect(writes()[0]?.auth).toBe('Bearer oauth_fixture');
    } finally { await oauth.close(); }
  });
  it('uses remote file paths and preserves paths and UTF-8', async () => {
    reply = call => call.url.includes('/files?') ? { text: 'Привет 🦎' } : { body: call.url.includes('/files/stat') ? { size: 16 } : { sandboxId: 's1' } };
    const file = "notes/a 'тест.txt";
    const result = await invoke('sandbox_write_file', { sandboxId: 's1', path: file, content: 'Привет 🦎', confirm: true });
    expect(result.isError).not.toBe(true);
    expect(writes()[0]).toMatchObject({ url: '/api/sandboxes/s1/files', body: { path: `/workspace/${file}`, content: 'Привет 🦎' } });
    const read = await invoke('sandbox_read_file', { sandboxId: 's1', path: file });
    expect(texts(read)).toContain('Привет 🦎');
    expect(calls.some(call => decodeURIComponent(call.url.replaceAll('+', ' ')).includes(`/workspace/${file}`))).toBe(true);
  });
  it('returns nonzero command exits without deleting the sandbox and clips output', async () => {
    reply = call => ({ body: call.url.endsWith('/exec') ? { stdout: '€'.repeat(30000), stderr: 'failure', exitCode: 7 } : { sandboxId: 's1' } });
    const result = await invoke('sandbox_exec', { sandboxId: 's1', command: 'run', confirm: true });
    expect(result.isError).not.toBe(true);
    const output = result.structuredContent as { exitCode: number; stdout: string; truncated: boolean };
    expect(output.exitCode).toBe(7);
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(65536);
    expect(calls.some(call => call.method === 'DELETE')).toBe(false);
  });
  it('destroys a sandbox after a failed command request, without retrying the command', async () => {
    reply = call => call.url.endsWith('/exec') ? { status: 502, body: { error: 'upstream disconnected' } } : { body: { sandboxId: 's1' } };
    expect((await invoke('sandbox_exec', { sandboxId: 's1', command: 'run', confirm: true })).isError).toBe(true);
    expect(writes().map(call => `${call.method} ${call.url}`)).toEqual(['POST /api/sandboxes/s1/exec', 'DELETE /api/sandboxes/s1']);
  });
  it('pauses and resumes a service, a project and a workspace (never destructive)', async () => {
    await invoke('service_pause', { project: 'demo', service: 'web' });
    await invoke('project_pause', { project: 'demo' });
    await invoke('workspace_resume', { workspaceId: 'w1' });
    await invoke('service_resume', { project: 'demo', service: 'web' });
    expect(writes().map((w) => `${w.method} ${w.url}`)).toEqual([
      'POST /api/apps/a1/pause?workspaceId=w1',
      'POST /api/projects/p1/pause?workspaceId=w1',
      'POST /api/workspaces/w1/resume',
      'POST /api/apps/a1/resume?workspaceId=w1',
    ]);
    for (const name of ['service_pause', 'project_pause', 'workspace_pause']) {
      expect((await client.listTools()).tools.find((tool) => tool.name === name)?.annotations?.destructiveHint).toBe(false);
    }
  });
  it('reads and sets serverless (sleep when idle) for a service', async () => {
    await invoke('service_sleep_status', { project: 'demo', service: 'web' });
    await invoke('service_sleep_set', { project: 'demo', service: 'web', enabled: true, idleMinutes: 30 });
    await invoke('service_sleep_set', { project: 'demo', service: 'web', enabled: false });
    expect(calls.filter((c) => c.url.includes('/sleep')).map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/apps/a1/sleep?workspaceId=w1',
      'PUT /api/apps/a1/sleep?workspaceId=w1',
      'PUT /api/apps/a1/sleep?workspaceId=w1',
    ]);
    expect(writes().map((w) => w.body)).toEqual([{ enabled: true, idleMinutes: 30 }, { enabled: false }]);
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
  it('a 402 on a create gives the agent the sentence and the link to open', async () => {
    const body = {
      error: 'INSUFFICIENT_CREDITS', code: 'PAYMENT_REQUIRED', status: 'trial_available',
      message: 'Start your 7-day Pro trial with $5 in credits to deploy. No charge today, then $19/month.',
      subscribeUrl: 'https://lizard.build/profile/account-billing?subscribe=1', billingUrl: 'https://lizard.build/profile/account-billing',
    };
    reply = () => ({ status: 402, body });
    for (const [name, args] of [
      ['service_create', { project: 'demo', name: 'web', region: 'eu', repoUrl: 'https://github.com/example/app' }],
      ['addon_create', { project: 'demo', name: 'db', type: 'postgres', region: 'eu' }],
      ['template_deploy', { template: 'demo', workspaceId: 'w1', projectName: 'copy' }],
    ] as const) {
      const result: any = await invoke(name, args);
      expect(result.isError).toBe(true);
      expect(texts(result)).toBe(`${body.message}\nStart the Pro trial: ${body.subscribeUrl}`);
      expect(result.structuredContent).toMatchObject({ error: { status: 402, code: 'PAYMENT_REQUIRED', paymentStatus: 'trial_available', subscribeUrl: body.subscribeUrl } });
    }
  });
  it('billing_status reads the plan and adds the Billing link', async () => {
    reply = () => ({ body: { plan: 'pro', status: 'trialing', trial: { endsAt: 1, usedCents: 120, remainingCents: 380 }, period: null } });
    const own = await invoke('billing_status');
    expect(own.structuredContent).toMatchObject({ plan: 'pro', status: 'trialing', billingUrl: 'https://lizard.build/profile/account-billing' });
    reply = () => ({ body: { plan: 'payg', status: 'none' } });
    const member = await invoke('billing_status', { workspaceId: 'w 1' });
    expect(member.structuredContent).toMatchObject({ plan: 'payg', notice: expect.stringContaining('November 1, 2026') });
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', '/api/billing/subscription'],
      ['GET', '/api/billing/subscription?workspaceId=w+1'],
    ]);
  });
  it('creates a sandbox from a template, size, volume or snapshot', async () => {
    reply = () => ({ body: { id: 's1', status: 'running', size: 'medium' } });
    const created = await invoke('sandbox_create', { project: 'demo', template: 'base', size: 'medium', region: 'eu', volume: 'data', lifetimeMs: 3600000, confirm: true });
    expect(created.structuredContent).toMatchObject({ sandboxId: 's1', size: 'medium', workdir: '/workspace' });
    await invoke('sandbox_create', { project: 'demo', snapshotId: 'snap1', volume: 'fcv-abc', confirm: true });
    expect(writes().map((w) => w.body)).toEqual([
      { template: 'base', projectId: 'p1', size: 'medium', timeoutMs: 3600000, region: 'eu', volumeName: 'data', metadata: { integration: 'lizard-mcp' } },
      { snapshotId: 'snap1', projectId: 'p1', timeoutMs: 300000, volumeId: 'fcv-abc', metadata: { integration: 'lizard-mcp' } },
    ]);
    calls = [];
    expect((await invoke('sandbox_create', { project: 'demo', snapshotId: 'snap1', size: 'large', confirm: true })).isError).toBe(true);
    expect((await invoke('sandbox_create', { project: 'demo', lifetimeMs: 86400001, confirm: true })).isError).toBe(true);
    expect(writes()).toEqual([]);
  });
  it('pauses and resumes a sandbox and waits for the state', async () => {
    let state = 'running';
    reply = (call) => {
      if (call.method === 'POST' && call.url.endsWith('/pause')) { state = 'paused'; return { body: { id: 's1', status: 'pausing' } }; }
      if (call.method === 'POST' && call.url.endsWith('/resume')) { state = 'running'; return { body: { id: 's1', status: 'resuming' } }; }
      return { body: { id: 's1', status: state } };
    };
    expect((await invoke('sandbox_pause', { sandboxId: 's1' })).structuredContent).toMatchObject({ status: 'paused' });
    expect((await invoke('sandbox_resume', { sandboxId: 's1' })).structuredContent).toMatchObject({ status: 'running' });
    expect(writes().map((w) => `${w.method} ${w.url}`)).toEqual(['POST /api/sandboxes/s1/pause', 'POST /api/sandboxes/s1/resume']);
  });
  it('snapshots, lists, forks, exposes and extends sandboxes', async () => {
    reply = (call) => {
      if (call.url === '/api/sandboxes/s1/snapshot') return { body: { id: 'snap1', status: 'processing' } };
      if (call.url === '/api/sandbox-snapshots/snap1') return { body: { id: 'snap1', status: 'ready' } };
      if (call.url === '/api/sandboxes/s1/fork') return { body: [{ sandbox: { id: 's2' } }, { error: 'WORKSPACE_SANDBOX_LIMIT' }] };
      if (call.url === '/api/sandboxes/s1/expose/3000' && call.method === 'POST') return { body: { hostname: 'h', url: 'https://h', port: 3000 } };
      return { body: [] };
    };
    expect((await invoke('sandbox_snapshot', { sandboxId: 's1', name: 'base', scope: 'project' })).structuredContent).toMatchObject({ id: 'snap1', status: 'ready' });
    await invoke('sandbox_snapshot_list', { project: 'demo' });
    expect((await invoke('sandbox_fork', { sandboxId: 's1', count: 2 })).isError).toBe(true); // no confirm
    expect((await invoke('sandbox_fork', { sandboxId: 's1', count: 2, confirm: true })).structuredContent).toMatchObject({ started: 1, failed: 1 });
    expect((await invoke('sandbox_expose_port', { sandboxId: 's1', port: 3000 })).structuredContent).toMatchObject({ url: 'https://h' });
    await invoke('sandbox_unexpose_port', { sandboxId: 's1', port: 3000 });
    await invoke('sandbox_set_timeout', { sandboxId: 's1', lifetimeMs: 600000 });
    await invoke('sandbox_list_files', { sandboxId: 's1', path: 'src' });
    await invoke('sandbox_snapshot_delete', { snapshotId: 'snap1', confirm: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/sandboxes/s1/snapshot', 'GET /api/sandbox-snapshots/snap1',
      'GET /api/projects', 'GET /api/projects/p1/snapshots',
      'POST /api/sandboxes/s1/fork',
      'POST /api/sandboxes/s1/expose/3000', 'DELETE /api/sandboxes/s1/expose/3000',
      'POST /api/sandboxes/s1/timeout',
      'GET /api/sandboxes/s1/files/list?path=%2Fworkspace%2Fsrc',
      'DELETE /api/sandbox-snapshots/snap1',
    ]);
    expect(writes().find((w) => w.url.endsWith('/fork'))?.body).toEqual({ count: 2 });
    expect(writes().find((w) => w.url.endsWith('/timeout'))?.body).toEqual({ timeoutMs: 600000 });
  });
  it('creates, resizes and deletes volumes, and refuses to delete an attached one', async () => {
    reply = (call) => {
      if (call.url.startsWith('/api/projects/p1/volume-limits')) return { body: { minSizeGb: 1, maxSizeGb: 100, defaultSizeGb: 5 } };
      if (call.method === 'GET' && call.url.startsWith('/api/projects/p1/volumes')) return { body: [{ id: 'v1', name: 'data', sizeGb: 5 }, { id: 'v2', name: 'busy', sizeGb: 5, attachedTo: 's9' }] };
      if (call.method === 'PATCH') return { status: 400, body: { error: 'Volumes cannot shrink', code: 'volume_shrink_unsupported' } };
      return { body: { ok: true } };
    };
    await invoke('volume_create', { project: 'demo', name: 'data', region: 'eu' });
    await invoke('volume_create', { project: 'demo', name: 'files', service: 'web' });
    const shrink = await invoke('volume_resize', { project: 'demo', volume: 'data', sizeGb: 1 });
    expect(texts(shrink)).toContain('volume_shrink_unsupported');
    expect((await invoke('volume_delete', { project: 'demo', volume: 'busy', confirm: true })).isError).toBe(true);
    await invoke('volume_delete', { project: 'demo', volume: 'v1', confirm: true });
    reply = (call) => call.url === '/api/apps/a1/volumes' ? { body: [{ id: 'kv1', name: 'files', sizeGb: 5 }] } : { body: { ok: true } };
    await invoke('volume_delete', { project: 'demo', service: 'web', volume: 'files', confirm: true });
    expect(writes().map((w) => [w.method, w.url, w.body])).toEqual([
      ['POST', '/api/projects/p1/volumes?workspaceId=w1', { name: 'data', sizeGb: 5, region: 'eu' }],
      ['POST', '/api/apps/a1/volumes', { name: 'files', sizeGb: 5, mountPath: '/data' }],
      ['PATCH', '/api/projects/p1/volumes/data?workspaceId=w1', { sizeGb: 1 }],
      ['DELETE', '/api/projects/p1/volumes/data?workspaceId=w1', undefined],
      ['DELETE', '/api/apps/a1/volumes/kv1', undefined],
      ['DELETE', '/api/projects/p1/k8s-volumes/kv1?workspaceId=w1', undefined],
    ]);
    expect((await client.listTools()).tools.find((t) => t.name === 'volume_resize')?.description).toContain('cannot shrink');
  });
  it('reads and sets workspace limits and resale prices, and deletes only empty workspaces', async () => {
    reply = (call) => call.url.endsWith('/resale-pricing') && call.method === 'GET'
      ? { body: { enabled: true, multipliers: { cpu: 2, memory: 2, storage: 1, egress: 1, objectStorage: 1, sandbox: 3 } } }
      : { body: { ok: true } };
    await invoke('workspace_limits_get', { workspaceId: 'w1' });
    await invoke('workspace_limits_set', { workspaceId: 'w1', maxRunningSandboxes: 5, maxCpuVcpus: null });
    expect((await invoke('workspace_limits_set', { workspaceId: 'w1' })).isError).toBe(true);
    await invoke('workspace_resale_pricing_get', { workspaceId: 'w1' });
    await invoke('workspace_resale_pricing_set', { workspaceId: 'w1', sandbox: 5 });
    await invoke('workspace_resale_pricing_set', { workspaceId: 'w1', off: true });
    expect((await invoke('workspace_delete', { workspaceId: 'w1' })).isError).toBe(true);
    await invoke('workspace_delete', { workspaceId: 'w1', confirm: true });
    expect(writes().map((w) => [w.method, w.url, w.body])).toEqual([
      ['PUT', '/api/workspaces/w1/limits', { maxRunningSandboxes: 5, maxCpuVcpus: null }],
      ['PUT', '/api/workspaces/w1/resale-pricing', { cpu: 2, memory: 2, storage: 1, egress: 1, objectStorage: 1, sandbox: 5 }],
      ['PUT', '/api/workspaces/w1/resale-pricing', {}],
      ['DELETE', '/api/workspaces/w1?requireEmpty=true', undefined],
    ]);
  });
  it('tells the agent what project_delete removes at once', async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'project_delete');
    expect(tool?.description).toContain('sandboxes, their volumes and snapshots are deleted at once');
  });
  it('sets DNS on a bought domain and refuses to replace records without force', async () => {
    const order = { id: 'o1', domain: 'example.com', status: 'registered', appId: null, expiresAt: null };
    reply = (call) => {
      if (call.url === '/api/domains/orders') return { body: { orders: [order] } };
      if (call.url === '/api/domains/orders/o1/dns' && call.method === 'GET') return { body: { version: 'v1', records: [{ name: 'api', type: 'A', value: '1.2.3.4', ttl: 1800 }, { name: '@', type: 'URL', value: 'http://www.example.com', ttl: 1800 }] } };
      return { body: { ok: true, attached: ['api.example.com'] } };
    };
    const refused = await invoke('domain_attach', { project: 'demo', service: 'web', hostname: 'api.example.com' });
    expect(refused.isError).toBe(true);
    expect(texts(refused)).toContain('api A 1.2.3.4');
    expect(writes()).toEqual([]);
    await invoke('domain_attach', { project: 'demo', service: 'web', hostname: 'api.example.com', force: true });
    await invoke('domain_dns_update', { domain: 'example.com', action: 'set', name: 'mail.example.com', type: 'MX', value: 'mx.example.net' });
    expect((await invoke('domain_dns_update', { domain: 'example.com', action: 'remove', name: 'api' })).isError).toBe(true);
    expect(writes().map((w) => [w.method, w.url, w.body])).toEqual([
      ['POST', '/api/domains/orders/o1/connect', { appId: 'a1', hostname: 'api.example.com', force: true }],
      ['PUT', '/api/domains/orders/o1/dns', { version: 'v1', records: [
        { name: 'api', type: 'A', value: '1.2.3.4', ttl: 1800 }, { name: '@', type: 'URL', value: 'http://www.example.com', ttl: 1800 },
        { name: 'mail', type: 'MX', value: 'mx.example.net', ttl: 1800, priority: 10 },
      ] }],
    ]);
  });
  it('explains that an API key cannot change bought-domain DNS', async () => {
    reply = (call) => {
      if (call.url === '/api/domains/orders') return { body: { orders: [{ id: 'o1', domain: 'example.com', status: 'registered' }] } };
      if (call.method === 'GET') return { body: { version: 'v1', records: [] } };
      return { status: 401, body: { error: 'Sign in required' } };
    };
    const result = await invoke('domain_dns_update', { domain: 'example.com', action: 'add', name: '@', type: 'TXT', value: 'hello' });
    expect(result.isError).toBe(true);
    expect(texts(result)).toContain('API key can read');
  });
  it('maps Lizard Git and GitHub repo forms for service_create', async () => {
    reply = () => ({ body: { id: 'a2' } });
    await invoke('service_create', { project: 'demo', name: 'site', region: 'eu', repoUrl: 'lizard:me/site' });
    await invoke('service_create', { project: 'demo', name: 'api', region: 'eu', repoUrl: 'me/api' });
    expect(writes().map((w) => w.body.repoUrl)).toEqual(['https://lizard.build/git/me/site', 'https://github.com/me/api']);
  });
  it('talks to Lizard Git with the caller token and never follows path tricks', async () => {
    reply = (call) => {
      if (call.url.startsWith('/git/api/repos?')) return { body: [{ owner: 'fixture', name: 'app' }] };
      if (call.url === '/git/api/repos' && call.method === 'POST') return { body: { owner: 'fixture', name: 'app' } };
      if (call.url === '/git/api/repos/fixture/app/actions/runs/1') return { body: { number: 1, status: 'failure', jobs: [{ id: 7, name: 'test' }] } };
      if (call.url === '/git/api/repos/fixture/app/actions/jobs/7/log.txt') return { text: 'x'.repeat(70000) + 'boom' };
      return { body: { ok: true } };
    };
    await invoke('repo_list');
    const created = await invoke('repo_create', { name: 'app', readme: true });
    expect(created.structuredContent).toMatchObject({ repo: 'fixture/app', url: expect.stringMatching(/\/git\/fixture\/app$/) });
    await invoke('repo_commit', { repo: 'fixture/app', branch: 'main', message: 'Add', files: [{ path: 'a.txt', content: 'hi' }], idempotencyKey: 'k1' });
    await invoke('pr_create', { repo: 'fixture/app', title: 'T', head: 'feature', draft: true });
    await invoke('pr_merge', { repo: 'fixture/app', number: 2, method: 'squash', deleteBranch: true });
    const run = await invoke('ci_run_show', { repo: 'fixture/app', number: 1, logs: true });
    const log = (run.structuredContent as any).logs.test;
    expect(log.truncated).toBe(true);
    expect(log.text.endsWith('boom')).toBe(true);
    expect((await invoke('repo_show', { repo: '../x' })).isError).toBe(true);
    expect((await invoke('repo_read_file', { repo: 'fixture/app', path: '../../x' })).isError).not.toBe(true); // path goes in the query, not the URL path
    expect(calls.filter((c) => c.url.startsWith('/git/')).every((c) => c.auth === 'Bearer liz_fixture')).toBe(true);
    expect(writes().map((w) => [w.method, w.url, w.body])).toEqual([
      ['POST', '/git/api/repos', { name: 'app', private: true, readme: true }],
      ['POST', '/git/api/repos/fixture/app/commits', { branch: 'main', message: 'Add', files: [{ path: 'a.txt', content: 'hi' }] }],
      ['POST', '/git/api/repos/fixture/app/issues', { title: 'T', head: 'feature', draft: true }],
      ['POST', '/git/api/repos/fixture/app/pulls/2/merge', { method: 'squash', deleteBranch: true }],
    ]);
    expect(calls.find((c) => c.url.startsWith('/git/api/repos?'))?.url).toBe('/git/api/repos?member=fixture');
  });
  it('allows discovery without a stdio token and explains auth when calling a tool', async () => {
    const anonymous = makeClient();
    try {
      await anonymous.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/stdio.ts'], cwd: process.cwd(), env: { ...env(), LIZARD_TOKEN: '', LIZARD_API_KEY: '' }, stderr: 'pipe' }));
      expect((await anonymous.listTools()).tools).toHaveLength(90);
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
