import { ShaderRegistry } from '@forgeax/engine-shader';
import type { ArtifactDescriptor } from '@forgeax/engine-types';
import { beforeEach, expect, it, vi } from 'vitest';
import { materialContribution } from '../../../render/src/assets/asset-decoders';
import { AssetRegistry } from '../asset-registry.js';
import { runtimeAssets } from '../internal/runtime-assets';
import {
  bundleMaterialFixture,
  materialProductionFixture,
} from './fixtures/material-production.js';
import { materialRecordFixture } from './fixtures/material-publication.js';

// Verified program views from earlier cases stay live until a collection, and
// a live view legitimately replaces a read; each case counts its own reads.
beforeEach(() => {
  const realm = globalThis as unknown as Record<symbol, { bytes: Map<string, unknown> }>;
  realm[Symbol.for('forgeax.assets.shared-immutable-data')]?.bytes.clear();
});

/** Production pools programs; loose transport (dev server, Runtime Packs) keeps one read each. */
function loosenPrograms(fixture: Awaited<ReturnType<typeof materialProductionFixture>>) {
  const directory = fixture.entry.packageUrl.slice(
    1,
    fixture.entry.packageUrl.lastIndexOf('/') + 1,
  );
  for (const asset of fixture.pack.assets as { artifacts?: Record<string, ArtifactDescriptor> }[])
    for (const [key, descriptor] of Object.entries(asset.artifacts ?? {})) {
      if (descriptor.byteRange === undefined) continue;
      const program = fixture.record.programs.find(({ artifact }) => artifact.path === key);
      if (program === undefined) throw new Error(`missing fixture program ${key}`);
      const path = `loose/${program.artifact.digest.replace(/^sha256:/, '')}.bin`;
      fixture.files.set(`${directory}${path}`, {
        type: 'asset',
        fileName: `${directory}${path}`,
        source: program.artifact.bytes,
      });
      const { byteRange: _pooled, ...loose } = descriptor;
      (asset.artifacts as Record<string, ArtifactDescriptor>)[key] = { ...loose, path };
    }
}

async function deferredMaterial(loose = true) {
  const record = materialRecordFixture({
    passes: [
      { name: 'Forward', program: { module: 'game::first' } },
      { name: 'Shadow', program: { module: 'game::second' } },
    ],
  });
  const fixture = await materialProductionFixture(true, record);
  if (loose) loosenPrograms(fixture);
  else {
    const report = await bundleMaterialFixture(fixture);
    expect(report).toMatchObject({ bundles: 1, entries: record.programs.length });
  }
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
  const registry = new AssetRegistry({ shaderRegistry: shaders });
  registry.installDecoder(materialContribution.kind, materialContribution.decoder);
  registry.configurePackIndex('/pack-index.json');
  const load = () => registry.load(record.guid, 'material');
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
    expect(ready.ok).toBe(true);
    if (ready.ok)
      expect(
        f.registry.getMaterialProjectionForPayload(
          runtimeAssets(f.registry)
            .borrow<import('@forgeax/engine-types').MaterialAsset>(ready.value)
            .unwrap(),
        ),
      ).toMatchObject({
        artifactHash: f.record.artifactDigest,
        publicationGeneration: f.record.publicationGeneration,
      });
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
      ok: false,
      error: {
        code: 'asset-integrity-failed',
        detail: { artifactKey: first.url.replace(/^\/assets\//, '') },
      },
    });
    if (!result.ok)
      expect(result.error.expected).toBe(
        `decoded artifact byteLength ${f.fixture.firstProgram.artifact.bytes.length}`,
      );
  } finally {
    await f.drain();
    await pending;
  }
});

it('does not publish material program facts after in-flight GUID invalidation', async () => {
  const f = await deferredMaterial();
  const pending = f.load();
  try {
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 300, interval: 5 });
    f.registry.invalidate(f.record.guid);
    for (const request of f.requests) request.release(f.good(request));
    expect(await pending).toMatchObject({ ok: false });
    expect(
      f.registry.getMaterialArtifact(f.record.programs[0]?.specializationKey ?? ''),
    ).toBeUndefined();
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
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.drain();
    await Promise.all([first, second]);
  }
});

it('reads one pooled production container for every program of a material', async () => {
  const f = await deferredMaterial(false);
  const first = f.load(),
    second = f.load();
  try {
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 300, interval: 5 });
    expect(f.requests[0]?.url).toMatch(/\/assets\/bundles\/[0-9a-f]{64}\.bin$/);
    for (const request of f.requests) request.release(f.good(request));
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(f.requests).toHaveLength(1);
    for (const program of f.record.programs)
      expect(f.registry.getMaterialArtifact(program.specializationKey)?.bytes).toEqual(
        program.artifact.bytes,
      );
  } finally {
    await f.drain();
    await Promise.all([first, second]);
  }
});
