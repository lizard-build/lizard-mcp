import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it.skipIf(process.env.LIZARD_LIVE_TESTS !== '1')('runs sandbox tools over MCP and removes the test sandbox', async () => {
  const token = process.env.LIZARD_API_KEY;
  const project = process.env.LIZARD_PROJECT_ID;
  if (!token || !project) throw new Error('Set LIZARD_API_KEY and LIZARD_PROJECT_ID');
  const client = new Client({ name: 'sandbox-live-test', version: '1' });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/stdio.ts'], cwd: process.cwd(), env: { ...env, LIZARD_TOKEN: token }, stderr: 'pipe' }));
  let sandboxId: string | undefined;
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  try {
    const created = await call('sandbox_create', { project, lifetimeMs: 300000, confirm: true });
    expect(created.isError).not.toBe(true);
    sandboxId = (created.structuredContent as { sandboxId: string }).sandboxId;
    expect(sandboxId).toBeTruthy();
    expect((await call('sandbox_list', { project })).isError).not.toBe(true);
    expect((await call('sandbox_show', { sandboxId })).isError).not.toBe(true);
    expect((await call('sandbox_write_file', { sandboxId, path: 'hello.txt', content: 'Привет 🦎', confirm: true })).isError).not.toBe(true);
    expect((await call('sandbox_read_file', { sandboxId, path: 'hello.txt' })).structuredContent).toMatchObject({ content: 'Привет 🦎' });
    const result = await call('sandbox_exec', { sandboxId, command: 'cat hello.txt', confirm: true });
    expect(result.structuredContent).toMatchObject({ stdout: 'Привет 🦎', exitCode: 0 });
    const timedOut = await call('sandbox_exec', { sandboxId, command: 'sleep 20', timeoutMs: 1000, confirm: true });
    expect(timedOut.isError).toBe(true);
    expect((await call('sandbox_delete', { sandboxId, confirm: true })).structuredContent).toMatchObject({ deleted: false });
  } finally {
    if (sandboxId) await call('sandbox_delete', { sandboxId, confirm: true });
    await client.close();
  }
}, 180000);
