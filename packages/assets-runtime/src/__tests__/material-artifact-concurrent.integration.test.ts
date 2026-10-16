import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import { loadMaterialReadyByGuid } from '../registry/load-by-guid.js';
import { materialProductionFixture } from './fixtures/material-production.js';
import { materialRecordFixture } from './fixtures/material-publication.js';

async function deferredMaterial() {
  const record = materialRecordFixture({
    passes: [
      { name: 'Forward', program: { module: 'game::first' } },
      { name: 'Shadow', program: { module: 'game::second' } },
    ],
  });
  const fixture = await materialProductionFixture(true, record);
  const originalPack = JSON.stringify(fixture.pack);
  const requests: { url: string; release: (response: Response) => void }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/pack-index.json') return new Response(JSON.stringify(fixture.entries));
    if (url === fixture.entry.packageUrl) return new Response(JSON.stringify(fixture.pack));
    return new Promise<Response>((release) => requests.push({ url, release }));
  });
  vi.stubGlobal('fetch', fetcher);
  const shaders = new ShaderRegistry({
    manifestUrl: undefined,
    device: {
      createShaderModule() {
        throw new Error('no GPU compilation');
      },
    } as never,
  });
  const registry = new AssetRegistry(shaders);
  registry.configurePackIndex('/pack-index.json');
  const specializationKey = record.specializationKey;
  if (specializationKey === undefined) throw new Error('missing fixture specialization');
  const load = () =>
    loadMaterialReadyByGuid(registry, {
      guid: record.guid,
      specializationKey,
    });
  const good = (request: (typeof requests)[number]) => {
    const file = fixture.files.get(request.url.slice(1));
    if (!file) throw new Error(`missing fixture ${request.url}`);
    return new Response(file.source as BodyInit);
  };
  // Also releases late serial requests in a red run without changing the probe's
  // critical assertion that no response has been released before all reads start.
  const drain = async () => {
    let handled = 0;
    for (let n = 0; n < 30; n++) {
      while (handled < requests.length) {
        const request = requests[handled++];
        if (request === undefined) throw new Error('missing deferred fixture request');
        request.release(good(request));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    vi.unstubAllGlobals();
  };
  return { record, fixture, originalPack, requests, registry, load, good, drain };
}

it('starts all distinct verified artifacts before any response and restores identical ordered bytes', async () => {
  const f = await deferredMaterial();
  const pending = f.load();
  try {
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 300, interval: 5 });
    for (const request of [...f.requests].reverse()) request.release(f.good(request));
    const ready = await pending;
    expect(ready).toMatchObject({ status: 'Ready' });
    if (ready.status === 'Ready') expect(ready.record).toEqual(f.record);
    expect(JSON.stringify(f.fixture.pack)).toBe(f.originalPack);
  } finally {
    await f.drain();
    await pending;
  }
});

it('retains the first program failure when the second corrupt response completes first', async () => {
  const f = await deferredMaterial();
  const pending = f.load();
  try {
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 300, interval: 5 });
    const [first, second] = f.requests;
    if (first === undefined || second === undefined)
      throw new Error('missing deferred fixture requests');
    second.release(new Response(new Uint8Array(3)));
    first.release(new Response(new Uint8Array(7)));
    const result = await pending;
    expect(result).toMatchObject({
      status: 'Error',
      error: { code: 'asset-artifact-integrity-mismatch', detail: { actual: '7' } },
    });
    if (result.status === 'Error')
      expect(result.error.expected).toBe(
        `decoded artifact byteLength ${f.fixture.firstProgram.artifact.bytes.length}`,
      );
  } finally {
    await f.drain();
    await pending;
  }
});

it('does not publish or retain artifact cache entries after in-flight GUID invalidation', async () => {
  const f = await deferredMaterial();
  const pending = f.load();
  try {
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 300, interval: 5 });
    f.registry.invalidate(f.record.guid);
    for (const request of f.requests) request.release(f.good(request));
    expect(await pending).not.toMatchObject({ status: 'Ready' });
    expect(f.registry.getMaterialReadiness(f.record.guid)).not.toMatchObject({ status: 'Ready' });
    expect(
      (f.registry.artifactCache as unknown as { cache: Map<string, unknown> }).cache.size,
    ).toBe(0);
  } finally {
    await f.drain();
    await pending;
  }
});

it('deduplicates the actual shared reads across two simultaneous material callers', async () => {
  const f = await deferredMaterial();
  const first = f.load(),
    second = f.load();
  try {
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 300, interval: 5 });
    for (const request of f.requests) request.release(f.good(request));
    expect(await first).toMatchObject({ status: 'Ready' });
    expect(await second).toMatchObject({ status: 'Ready' });
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.drain();
    await Promise.all([first, second]);
  }
});
