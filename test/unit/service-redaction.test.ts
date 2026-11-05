import { describe, expect, it } from 'vitest';
import { redactServiceDetails } from '../../src/lib/service-redaction.js';

describe('service details returned for status queries', () => {
  it('keeps status fields and masks nested addon credentials without changing the source', () => {
    const source = { addons: [{ id: 'db1', name: 'cache', running: true, connection: {
      host: 'cache.example', password: 'fixture-db-password', url: 'redis://user:fixture-db-password@cache.example:6379',
    }, secretAccessKey: 'fixture-storage-key' }] };
    const result = redactServiceDetails(source) as typeof source;
    expect(result.addons[0]).toMatchObject({ id: 'db1', name: 'cache', running: true });
    expect(JSON.stringify(result)).not.toContain('fixture-db-password');
    expect(JSON.stringify(result)).not.toContain('fixture-storage-key');
    expect(source.addons[0].connection.password).toBe('fixture-db-password');
  });

  it.each([true, false])('masks environment values when JSON-encoded is %s', (encoded) => {
    const envVars = { API_KEY: 'fixture-env-secret', ORDINARY_NAME: 'also-private', UNSET: null };
    const result = redactServiceDetails({ envVars: encoded ? JSON.stringify(envVars) : envVars }) as { envVars: unknown };
    const vars = encoded ? JSON.parse(result.envVars as string) : result.envVars;
    expect(vars).toEqual({ API_KEY: '***', ORDINARY_NAME: '***', UNSET: null });
    expect(JSON.stringify(result)).not.toContain('fixture-env-secret');
  });

  it('hides malformed environment text and build logs while keeping build status', () => {
    expect(redactServiceDetails({ envVars: 'API_KEY=fixture-secret', builds: [{ status: 'done', logSnippet: 'echo fixture-secret' }] }))
      .toEqual({ envVars: '***', builds: [{ status: 'done', logSnippet: '***' }] });
  });

  it('removes URL credentials and preserves a public source URL and null fields', () => {
    const result = redactServiceDetails({
      repoUrl: 'https://fixture-user:fixture-token@example.com/repo',
      publicUrl: 'https://example.com/repo', domain: null,
    });
    expect(result).toEqual({ repoUrl: 'https://***:***@example.com/repo', publicUrl: 'https://example.com/repo', domain: null });
  });

  it('masks credential aliases and non-URL connection strings', () => {
    expect(redactServiceDetails({ apiKey: 'a', api_key: 'b', authorization: 'Bearer c',
      dsn: 'host=db password=d', connectionString: 'Password=e;Server=db', id: 's1' }))
      .toEqual({ apiKey: '***', api_key: '***', authorization: '***', dsn: '***', connectionString: '***', id: 's1' });
  });

  it('removes repeated credential query parameters while preserving routing parameters', () => {
    const result = redactServiceDetails({ url: 'https://s1.example/path?lizard_token=a&access_token=b&api-key=c&access_token=d&port=3000' }) as { url: string };
    const url = new URL(result.url);
    expect(url.searchParams.getAll('access_token')).toEqual(['***']);
    expect(url.searchParams.get('lizard_token')).toBe('***');
    expect(url.searchParams.get('api-key')).toBe('***');
    expect(url.searchParams.get('port')).toBe('3000');
    expect(url.pathname).toBe('/path');
  });
});

