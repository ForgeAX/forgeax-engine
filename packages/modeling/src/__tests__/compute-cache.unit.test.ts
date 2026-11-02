import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { type ByteCache, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { bakeSources, createBakeCooker } from '../bake';
import { tsBakeBackend } from '../compute/bake-ts';
import {
  type BackendOutput,
  type ComputeBackend,
  type ComputeJobKind,
  type ComputeJobRequest,
  type ComputeOptions,
  computeCacheKey,
  runComputeJob,
} from '../compute/job';
import { decodeJobEntry, encodeJobEntry } from '../compute/job-cache';
import {
  type AssetsJob,
  assetsJobOutputs,
  assetsJobSources,
  createMeshJobCooker,
} from '../mesh-job';
import { model } from '../model';

/** A map store that counts reads and writes. */
function store(): ByteCache & { entries: Map<string, Uint8Array>; gets: number; puts: number } {
  const entries = new Map<string, Uint8Array>();
  return {
    entries,
    gets: 0,
    puts: 0,
    get(key) {
      this.gets++;
      return entries.get(key);
    },
    put(key, bytes) {
      this.puts++;
      entries.set(key, bytes);
    },
  };
}

/** The TS bake backend under the same identity, counting its runs. */
function counted(): ComputeBackend & { runs: number } {
  const backend = {
    ...tsBakeBackend,
    runs: 0,
    run<K extends ComputeJobKind>(
      request: ComputeJobRequest<K>,
      work: Parameters<ComputeBackend['run']>[1],
    ) {
      backend.runs++;
      return tsBakeBackend.run(request, work);
    },
  };
  return backend;
}

function plate(segments: number, bump: number) {
  const m = model();
  m.plane({ width: 1, height: 1, widthSegments: segments, heightSegments: segments });
  const mesh = m.editMesh;
  for (const v of mesh.vertices()) {
    const [x, y, z] = mesh.position(v);
    mesh.setPosition(v, x, y, z + bump * x * y);
  }
  if (segments < 8) expect(m.uv.auto({ resolution: 32, padding: 2 }).status).toBe('ok');
  return m;
}

function bakeRequest(rays: number): ComputeJobRequest<'bake'> {
  const sources = bakeSources({
    base: plate(2, 0),
    detail: plate(12, 0.2),
    maps: ['normal', 'ao'],
    resolution: 16,
    ao: { rays },
    key: 'c',
  });
  if (!sources.ok) throw sources.error;
  const source = sources.value['texture/c-ao']?.source as {
    base: string;
    detail: string;
    params: ComputeJobRequest<'bake'>['params'];
  };
  return {
    kind: 'bake',
    inputs: [Buffer.from(source.base, 'base64'), Buffer.from(source.detail, 'base64')].map(
      (b) => new Uint8Array(b),
    ),
    params: source.params,
  };
}

const run = (
  request: ComputeJobRequest<'bake'>,
  backend: ComputeBackend,
  options: ComputeOptions,
) => runComputeJob(request, backend, { policy: 'ts', ...options });

describe('compute-job cache (ComputeOptions.cache)', () => {
  it('a hit returns the miss result byte for byte without running the job', () => {
    const cache = store();
    const backend = counted();
    const request = bakeRequest(8);
    const miss = run(request, backend, { cache });
    if (!miss.ok) throw miss.error;
    expect([backend.runs, cache.puts]).toEqual([1, 1]);
    const hit = run(request, backend, { cache });
    if (!hit.ok) throw hit.error;
    expect(backend.runs).toBe(1);
    expect(hit.value).toEqual(miss.value);
    expect(hit.value.outputs.map((o) => Buffer.from(o).toString('hex'))).toEqual(
      miss.value.outputs.map((o) => Buffer.from(o).toString('hex')),
    );
    const bare = run(request, counted(), {});
    if (!bare.ok) throw bare.error;
    expect(hit.value).toEqual(bare.value);
    expect([...cache.entries.keys()]).toEqual([computeCacheKey(request, tsBakeBackend.identity)]);
  });

  it('a corrupt, truncated or foreign entry is ignored and recomputed (falsifier)', () => {
    const request = bakeRequest(8);
    const key = computeCacheKey(request, tsBakeBackend.identity);
    const cache = store();
    const backend = counted();
    const reference = run(request, backend, { cache });
    if (!reference.ok) throw reference.error;
    const good = cache.entries.get(key) as Uint8Array;
    const flipped = good.slice();
    flipped[flipped.length - 3] = (flipped[flipped.length - 3] as number) ^ 1;
    const badDigest = good.slice();
    badDigest[9] = (badDigest[9] as number) ^ 0x80;
    const other = bakeRequest(9);
    const foreign = store();
    run(other, counted(), { cache: foreign });
    for (const bad of [
      flipped,
      badDigest,
      good.subarray(0, good.length - 1),
      new Uint8Array(0),
      foreign.entries.get(computeCacheKey(other, tsBakeBackend.identity)) as Uint8Array,
    ]) {
      cache.entries.set(key, bad);
      const before = backend.runs;
      const again = run(request, backend, { cache });
      if (!again.ok) throw again.error;
      expect(backend.runs).toBe(before + 1);
      expect(again.value).toEqual(reference.value);
      expect(cache.entries.get(key)).toEqual(good);
    }
  });

  it('a changed setting (AO rays) misses; an entry over the budget or a cancelled run is not served', () => {
    const cache = store();
    const backend = counted();
    const eight = bakeRequest(8);
    expect(run(eight, backend, { cache }).ok).toBe(true);
    const nine = run(bakeRequest(9), backend, { cache });
    expect(backend.runs).toBe(2);
    expect(cache.entries.size).toBe(2);
    if (!nine.ok) throw nine.error;
    const work = nine.value.report.metrics.work as number;
    const tight = run(bakeRequest(9), backend, { cache, budget: work - 1 });
    expect(tight.ok ? 'ok' : tight.error.code).toBe('model-work-budget');
    expect(backend.runs).toBe(3);
    expect(run(bakeRequest(9), backend, { cache, budget: work }).ok).toBe(true);
    expect(backend.runs).toBe(3);
    const gets = cache.gets;
    const cancelled = run(eight, backend, { cache, signal: { aborted: true } });
    expect(cancelled.ok ? 'ok' : cancelled.error.code).toBe('model-cancelled');
    expect(cache.gets).toBe(gets);
  });

  it('round-trips typed arrays, -0, NaN and undefined; uncacheable values are not stored', () => {
    const provenance = {
      faceChart: Int32Array.of(-1, 0, 7),
      weights: Float32Array.of(0.5, -0),
      list: [{ a: -0, b: Number.NaN, c: undefined }, null, true, '\u00e9'],
    };
    const job = {
      status: 'partial' as const,
      outputs: [Uint8Array.of(1, 2, 3)],
      provenance,
      locations: [],
      metrics: { work: 5 },
    };
    const entry = encodeJobEntry('k', job);
    if (entry === undefined) throw new Error('encodable');
    const back = decodeJobEntry('k', entry);
    expect(back).toEqual(job);
    const list = (back?.provenance as typeof provenance).list[0] as { a: number; b: number };
    expect(Object.is(list.a, -0)).toBe(true);
    expect(back?.provenance).toMatchObject({ faceChart: expect.any(Int32Array) });
    expect(decodeJobEntry('other', entry)).toBeUndefined();
    expect(encodeJobEntry('k', { ...job, provenance: new Map() })).toBeUndefined();
    expect(encodeJobEntry('k', { ...job, provenance: new Array(2) })).toBeUndefined();
    const fake: ComputeBackend = {
      name: 'ts',
      identity: 'fake',
      supports: () => true,
      quality: () => 'baseline',
      run: <K extends ComputeJobKind>() =>
        ok({
          status: 'ok',
          outputs: [],
          provenance: new Map(),
          metrics: {},
          locations: [],
        } as unknown as BackendOutput<K>),
    };
    const cache = store();
    expect(
      runComputeJob({ kind: 'region', inputs: [], params: {} as never }, fake, { cache }).ok,
    ).toBe(true);
    expect(cache.puts).toBe(0);
  });
});

describe('cook hosts forward their store', () => {
  it('a fresh bake cooker serves the stored bake: same texture, no new entry', async () => {
    const sources = bakeSources({
      base: plate(2, 0),
      detail: plate(12, 0.2),
      maps: ['normal', 'ao'],
      resolution: 16,
      ao: { rays: 8 },
      key: 'c',
    });
    if (!sources.ok) throw sources.error;
    const source = JSON.parse(JSON.stringify(sources.value['texture/c-ao']?.source));
    const guid = '01900000-0000-7000-8000-00000000cac0';
    const cache = store();
    const first = await createBakeCooker().cook({ guid, source }, { cache });
    expect([cache.gets, cache.puts]).toEqual([1, 1]);
    const second = await createBakeCooker().cook({ guid, source }, { cache });
    expect([cache.gets, cache.puts]).toEqual([2, 1]);
    expect(second).toEqual(first);
    expect(second).toEqual(await createBakeCooker().cook({ guid, source }));
  });

  it('the mesh-job cooker hands the registry store to an assets job build', async () => {
    const PACKAGE = definePackageId('019fb7ce-4200-7000-8000-0000000cac0e');
    const seen: (ByteCache | undefined)[] = [];
    const JOB: AssetsJob<Record<string, never>> = {
      kind: 'assets',
      name: 'cached',
      build: async (_p, { cache }) => {
        seen.push(cache);
        const finished = plate(2, 0).finish({ key: 'cached' });
        return finished.ok ? ok(finished.value) : finished;
      },
    };
    const options = { key: 'cached', packageId: PACKAGE, params: {} };
    const outputs = await assetsJobOutputs(JOB, options);
    if (!outputs.ok) throw outputs.error;
    const sources = await assetsJobSources(JOB, { ...options, outputs: outputs.value });
    if (!sources.ok) throw sources.error;
    const cache = store();
    const registry = new NativeCookerRegistry({ cache: () => cache });
    registry.register(createMeshJobCooker([JOB]));
    seen.length = 0;
    const [key, entry] = Object.entries(sources.value)[0] as [string, { source: unknown }];
    const guid = AssetGuid.format(AssetGuid.derive(PACKAGE, key));
    const draft = await registry.runDraft('modeling-mesh-job', { guid, source: entry.source });
    expect(draft.ok).toBe(true);
    expect(seen).toEqual([cache]);
  });
});
