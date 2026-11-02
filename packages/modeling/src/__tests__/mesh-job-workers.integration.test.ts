import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMeshJobCooker, type MeshJobRequest } from '@forgeax/engine-modeling';
import { meshJobWorkers } from '@forgeax/engine-modeling/tools';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import type { ByteCache } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript fixture shared with the job Workers
import { FIXTURE_JOBS } from './fixtures/mesh-jobs.mjs';

const PACKAGE = definePackageId('01900000-0000-7000-8000-0000000c7001');
const GiB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryCache(entries: Record<string, Uint8Array> = {}): ByteCache & {
  readonly entries: Map<string, Uint8Array>;
} {
  const map = new Map(Object.entries(entries));
  return {
    entries: map,
    get: (key) => map.get(key),
    put: (key, bytes) => void map.set(key, bytes),
  };
}

function request(job: string, params: MeshJobRequest['params'] = {}): MeshJobRequest {
  const fixture = FIXTURE_JOBS.find((entry: { name: string }) => entry.name === job);
  return {
    module: fixture.module,
    job,
    key: 'lid',
    packageId: '01900000-0000-7000-8000-0000000c7001',
    params,
    identity: 'test-kernel@1',
  };
}

/** The serialized outputs, typed arrays included, for byte comparison. */
const bytes = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    ArrayBuffer.isView(item) ? Array.from(item as Float32Array) : item,
  );

async function cook(
  executor: ReturnType<typeof meshJobWorkers> | undefined,
  job: string,
  cache?: ByteCache,
) {
  const registry = new NativeCookerRegistry(cache === undefined ? {} : { cache: () => cache });
  registry.register(createMeshJobCooker(FIXTURE_JOBS, executor === undefined ? {} : { executor }));
  const fixture = FIXTURE_JOBS.find((entry: { name: string }) => entry.name === job);
  const outputs =
    job === 'fixture.fail'
      ? ['mesh/lid']
      : Object.keys((await fixture.build({ depth: 0.04 }, {})).value);
  const { assetsJobSources } = await import('@forgeax/engine-modeling');
  const sources = await assetsJobSources(fixture, {
    key: 'lid',
    packageId: PACKAGE,
    params: job === 'fixture.lid' ? { depth: 0.04 } : {},
    outputs,
  });
  if (!sources.ok) throw sources.error;
  return Promise.all(
    Object.entries(sources.value).map(([key, entry]) =>
      registry.runDraft('modeling-mesh-job', {
        guid: AssetGuid.format(AssetGuid.derive(PACKAGE, key)),
        source: (entry as { source: unknown }).source,
      }),
    ),
  );
}

describe('mesh jobs in Worker threads', () => {
  it('publishes the same drafts as the inline build, and the same failure', async () => {
    const executor = meshJobWorkers({ minFreeGb: 0 });
    const [inline, worker] = [
      await cook(undefined, 'fixture.lid'),
      await cook(executor, 'fixture.lid'),
    ];
    expect(worker.every((draft) => draft.ok)).toBe(true);
    expect(bytes(worker.map((draft) => draft.ok && draft.value))).toBe(
      bytes(inline.map((draft) => draft.ok && draft.value)),
    );
    const [inlineFail, workerFail] = [
      await cook(undefined, 'fixture.fail'),
      await cook(executor, 'fixture.fail'),
    ];
    expect(workerFail[0]?.ok).toBe(false);
    expect(JSON.stringify(workerFail[0])).toBe(JSON.stringify(inlineFail[0]));
    expect(JSON.stringify(workerFail[0])).toContain('fixture-failed');
  }, 60_000);

  it('serves the compute cache to the Worker and records its peak only as a hint', async () => {
    const executor = meshJobWorkers({ minFreeGb: 0 });
    const expected = bytes((await cook(undefined, 'fixture.lid')).map((d) => d.ok && d.value));
    const cache = memoryCache();
    const first = await cook(executor, 'fixture.lid', cache);
    expect(bytes(first.map((d) => d.ok && d.value))).toBe(expected);
    // The Worker's own compute-cache write reached the host store through the channel.
    expect(cache.entries.get('fixture.lid:0.04')).toEqual(new Uint8Array([1, 2, 3]));
    const peak = [...cache.entries.keys()].find((key) => key.startsWith('peak:fixture.lid@'));
    if (peak === undefined) throw new Error('the job peak was recorded');
    // A corrupted or missing record changes the estimate only, never the outputs.
    for (const record of [new TextEncoder().encode('{"bytes":"x"}'), undefined]) {
      if (record === undefined) cache.entries.delete(peak);
      else cache.entries.set(peak, record);
      const again = await cook(executor, 'fixture.lid', cache);
      expect(bytes(again.map((d) => d.ok && d.value))).toBe(expected);
    }
  }, 60_000);

  it('turns a cache read into a miss when the owner thread is busy, never a hang', async () => {
    const logs: string[] = [];
    const executor = meshJobWorkers({ minFreeGb: 0, cacheWaitMs: 300, log: (m) => logs.push(m) });
    const answered = await executor(request('fixture.probe'), {
      cache: memoryCache({ probe: new Uint8Array([1]) }),
    });
    expect(answered?.ok && Object.keys(answered.value)).toEqual(['mesh/hit']);
    const pending = executor(request('fixture.probe'), {
      cache: memoryCache({ probe: new Uint8Array([1]) }),
    });
    // Synchronous work on the owner thread, as an inline job would do.
    const end = Date.now() + 4000;
    while (Date.now() < end) {}
    const result = await pending;
    expect(result?.ok && Object.keys(result.value)).toEqual(['mesh/miss']);
    expect(logs.some((line) => line.includes('did not answer within 300 ms'))).toBe(true);
  }, 60_000);

  async function overlap(executor: ReturnType<typeof meshJobWorkers>, cache?: ByteCache) {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-job-workers-'));
    dirs.push(dir);
    const log = join(dir, 'log.jsonl');
    const results = await Promise.all(
      ['a', 'b'].map((tag) =>
        executor(
          request('fixture.block', { ms: 1500, log, tag }),
          cache === undefined ? {} : { cache },
        ),
      ),
    );
    expect(results.every((result) => result?.ok)).toBe(true);
    const [first, second] = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { start: number; end: number })
      .sort((left, right) => left.start - right.start);
    if (first === undefined || second === undefined) throw new Error('both jobs ran');
    return second.start < first.end;
  }

  it('admits by memory: low memory runs jobs one at a time, ample memory overlaps them', async () => {
    const floor = 12;
    const low = meshJobWorkers({ minFreeGb: floor, memAvailable: () => (floor - 1) * GiB });
    expect(await overlap(low)).toBe(false);
    const ample = meshJobWorkers({ minFreeGb: floor, memAvailable: () => (floor + 64) * GiB });
    expect(await overlap(ample)).toBe(true);
    // Room for one default 3 GiB estimate: a recorded 0.5 GiB peak lets two overlap,
    // a corrupted record falls back to the default and they do not.
    const tight = { minFreeGb: floor, memAvailable: () => (floor + 4) * GiB };
    const recorded = memoryCache({
      'peak:fixture.block@test-kernel@1': new TextEncoder().encode(
        JSON.stringify({ bytes: GiB / 2 }),
      ),
    });
    expect(await overlap(meshJobWorkers(tight), recorded)).toBe(true);
    const corrupted = memoryCache({
      'peak:fixture.block@test-kernel@1': new TextEncoder().encode('not json'),
    });
    expect(await overlap(meshJobWorkers(tight), corrupted)).toBe(false);
  }, 120_000);
});
