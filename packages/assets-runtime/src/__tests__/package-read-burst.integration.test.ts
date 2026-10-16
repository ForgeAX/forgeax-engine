import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { bytesOf, readPackage } from '../internal/package-read.js';

it('loads a large artifact burst without overflowing the transport while bodies are pending', async () => {
  let active = 0;
  let peak = 0;
  let rejected = 0;
  const server = createServer((_request, response) => {
    active++;
    peak = Math.max(peak, active);
    if (active > 64) {
      rejected++;
      active--;
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200);
    response.write('first-');
    setTimeout(() => {
      active--;
      response.end('last');
    }, 40);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('listener unavailable');
  try {
    const results = await Promise.all(
      Array.from({ length: 160 }, (_, index) =>
        readPackage(fetch, `http://127.0.0.1:${address.port}/${index}.wgsl`, bytesOf),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(rejected).toBe(0);
    expect(peak).toBeLessThanOrEqual(32);
    for (const result of results)
      if (result.ok) expect(new TextDecoder().decode(result.value)).toBe('first-last');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('releases transfer slots after malformed bodies and preserves failure diagnostics', async () => {
  const fetcher = vi.fn(async () => new Response('invalid'));
  const results = await Promise.all(
    Array.from({ length: 96 }, () =>
      readPackage(fetcher, 'https://fixture.test/a', (r) => r.json()),
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(96);
  expect(results.every((result) => !result.ok && result.error.malformed)).toBe(true);
  const healthy = await readPackage(fetcher, 'https://fixture.test/b', bytesOf);
  expect(healthy.ok).toBe(true);
});

it('does not send a queued read after its owner aborts', async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fetcher = vi.fn(async () => new Response('body'));
  const active = Array.from({ length: 32 }, () =>
    readPackage(fetcher, 'https://fixture.test/active', async (response) => {
      await gate;
      return response.text();
    }),
  );
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(32));
  const owner = new AbortController();
  const queued = readPackage(fetcher, 'https://fixture.test/queued', bytesOf, {
    signal: owner.signal,
  });
  owner.abort();
  const result = await queued;
  finish();
  await Promise.all(active);
  expect(fetcher).toHaveBeenCalledTimes(32);
  expect(result).toEqual({
    ok: false,
    error: { observed: 'AbortError: aborted', attempts: 0, malformed: false },
  });
});
