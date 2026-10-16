import { afterEach, expect, it, vi } from 'vitest';
import { createApiClient } from '../../src/lib/api.js';
import { execInSandbox } from '../../src/tools/sandboxes.js';
import { getServer } from '../../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const ctx = { accessToken: 'caller-token', api: createApiClient('caller-token') };
function pendingRequest(failCleanup = false) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => {
    if (init?.method === 'DELETE') return failCleanup ? new Response('{}', { status: 500 }) : new Response(null, { status: 204 });
    return new Promise<Response>((_, reject) => {
      const signal = init!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
}
it('stops remote code by destroying its sandbox on cancellation', async () => {
  const fetch = pendingRequest();
  const controller = new AbortController();
  const pending = execInSandbox(ctx, 'owned', 'sleep 60', '/workspace', 60000, controller.signal);
  controller.abort(new Error('cancelled'));
  await expect(pending).rejects.toThrow('destroyed');
  expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['POST', 'DELETE']);
  expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: 'Bearer caller-token' });
});
it('destroys a sandbox on timeout even if the request stalls', async () => {
  const fetch = pendingRequest();
  await expect(execInSandbox(ctx, 'owned', 'sleep 60', '/workspace', 20, new AbortController().signal)).rejects.toThrow('destroyed');
  expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(['POST', 'DELETE']);
});
it('does not touch a sandbox if cancelled before execution', async () => {
  const fetch = pendingRequest();
  const controller = new AbortController();
  controller.abort();
  await expect(execInSandbox(ctx, 'owned', 'ls', '/workspace', 1000, controller.signal)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('reports failed cleanup without retrying a command', async () => {
  const fetch = pendingRequest(true);
  const controller = new AbortController();
  const pending = execInSandbox(ctx, 'owned', 'run', '/workspace', 1000, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('Do not repeat');
  expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
});
it('preserves the sandbox when the platform rejects access before execution', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"Forbidden"}', { status: 403 }));
  await expect(execInSandbox(ctx, 'owned', 'ls', '/workspace', 1000, new AbortController().signal)).rejects.toThrow('Forbidden');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('never falls back to the host SDK key for a caller without a token', async () => {
  vi.stubEnv('LIZARD_API_KEY', 'host-secret');
  const fetch = vi.spyOn(globalThis, 'fetch');
  const server = getServer('');
  const client = new Client({ name: 'no-token-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const result = await client.callTool({ name: 'sandbox_show', arguments: { sandboxId: 's1' } });
    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  } finally { await client.close(); await server.close(); }
});
