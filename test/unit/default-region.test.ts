import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getServer } from '../../src/server.js';

afterEach(() => { vi.restoreAllMocks(); });

async function call(name: string, args: Record<string, unknown>) {
  const posts: { url: string; body: any }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ id: 'new1', name: 'x' });
    }
    if (url.includes('/volume-limits')) return Response.json({ defaultSizeGb: 5 });
    return Response.json([{ id: 'p1', name: 'proj', slug: 'proj', workspaceId: 'w1' }]);
  });
  const server = getServer('caller-token');
  const client = new Client({ name: 'region-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();
  } finally { await client.close(); await server.close(); }
  return posts;
}

it.each([
  ['service_create', { project: 'proj', name: 'web' }],
  ['addon_create', { project: 'proj', type: 'postgres' }],
  ['volume_create', { project: 'proj', name: 'data' }],
])('%s with no region creates in us-east-1', async (tool, args) => {
  const posts = await call(tool, args);
  expect(posts).toHaveLength(1);
  expect(posts[0].body.region).toBe('us-east-1');
});

it('keeps a region the caller names', async () => {
  const posts = await call('service_create', { project: 'proj', name: 'web', region: 'eu-west-lim-a' });
  expect(posts[0].body.region).toBe('eu-west-lim-a');
});
