import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { playwrightWithBackgroundPages } from '../../config/vitest-browser-provider';

const fixture = vi.hoisted(() => ({ createContext: vi.fn() }));
vi.mock('@vitest/browser-playwright', () => ({
  playwright: () => ({ providerFactory: () => fixture }),
}));
afterEach(() => vi.restoreAllMocks());

it('retains the actual failed scoped Catalog body without issuing a diagnostic retry', async () => {
  const context = new EventEmitter();
  fixture.createContext.mockResolvedValue(context);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const provider = playwrightWithBackgroundPages().providerFactory?.({
    config: { browser: { name: 'chromium', headless: true } },
  } as never) as unknown as { createContext(session: string, options: object): Promise<unknown> };
  await provider.createContext('catalog-diagnostic', {});
  const request = {
    url: () => 'http://127.0.0.1:5123/__pack/scopes/browser-tests/1/catalog.json',
    method: () => 'GET',
    resourceType: () => 'fetch',
  };
  const body = Buffer.from(JSON.stringify({ error: 'produce-failed', cause: { code: 'fixture' } }));
  const read = vi.fn(async () => body);
  context.emit('response', {
    request: () => request,
    status: () => 500,
    headers: () => ({ 'content-type': 'application/json', 'content-length': String(body.length) }),
    body: read,
  });
  context.emit('requestfinished', request);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  const output = stderr.mock.calls.map(([text]) => String(text)).join('');
  expect(output).toContain('"kind":"http-error"');
  expect(output).toContain('"bodyState":"OBSERVED"');
  expect(output).toContain('produce-failed');
  expect(output).toContain('fixture');
});
