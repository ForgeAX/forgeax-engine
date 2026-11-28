import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const HEAP_CHILD = fileURLToPath(new URL('./fixtures/worker-heap-child.mjs', import.meta.url));
const dirs: string[] = [];

/**
 * One pool job in a child process without the parent's NODE_OPTIONS: `--max-old-space-size`
 * there overrides a Worker's resourceLimits, so the cap would not bite under the lane's flags.
 */
function workerHeapChild(mode: 'mesh' | 'bake' | 'idle', maxHeapMb: number, timeout = 100_000) {
  const { NODE_OPTIONS: _flags, ...env } = process.env;
  const out = execFileSync(process.execPath, [HEAP_CHILD, mode, String(maxHeapMb)], {
    env,
    encoding: 'utf8',
    timeout,
  });
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as {
    ok: boolean;
    code?: string;
    text?: string;
    afterCode?: string;
  };
}
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

  describe('bounds', () => {
    const run = (executor: ReturnType<typeof meshJobWorkers>, job: string, params = {}) =>
      executor(request(job, params), {});

    it('ends a job that outlives its deadline and keeps serving', async () => {
      const executor = meshJobWorkers({ minFreeGb: 0, maxJobs: 1, jobTimeoutMs: 1500 });
      const started = Date.now();
      const hung = await run(executor, 'fixture.hang', { ms: 60_000 });
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(hung).toMatchObject({ ok: false, error: { code: 'model-work-budget' } });
      const after = await run(executor, 'fixture.fail');
      expect(after).toMatchObject({ ok: false, error: { code: 'fixture-failed' } });
    }, 60_000);

    it('fails the build, not the host, when a Worker exits mid-job', async () => {
      const executor = meshJobWorkers({ minFreeGb: 0, maxJobs: 1 });
      expect(await run(executor, 'fixture.exit')).toMatchObject({
        ok: false,
        error: { code: 'model-capability-unavailable', detail: { exitCode: 3 } },
      });
      expect(await run(executor, 'fixture.fail')).toMatchObject({
        ok: false,
        error: { code: 'fixture-failed' },
      });
    }, 60_000);

    it('bounds the queue', async () => {
      const executor = meshJobWorkers({ minFreeGb: 0, maxJobs: 1, maxQueue: 1 });
      const running = run(executor, 'fixture.hang', { ms: 1500 });
      const waiting = run(executor, 'fixture.fail');
      const refused = await run(executor, 'fixture.fail');
      expect(refused).toMatchObject({ ok: false, error: { code: 'model-work-budget' } });
      expect(await running).toMatchObject({ ok: true });
      expect(await waiting).toMatchObject({ ok: false, error: { code: 'fixture-failed' } });
    }, 60_000);

    it('ends a Worker whose job outlives the deadline, so the job stops running (falsifier)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mesh-job-deadline-'));
      dirs.push(dir);
      const log = join(dir, 'log.jsonl');
      const executor = meshJobWorkers({ minFreeGb: 0, maxJobs: 1, jobTimeoutMs: 600 });
      const hung = await run(executor, 'fixture.block', { ms: 3000, log, tag: 'late' });
      expect(hung).toMatchObject({ ok: false, error: { code: 'model-work-budget' } });
      // The job would write its line at 3 s were its Worker still alive.
      await new Promise((resolve) => setTimeout(resolve, 4000));
      expect(existsSync(log)).toBe(false);
    }, 60_000);

    it('clears the deadline once a job settles, so a warm Worker survives it (falsifier)', async () => {
      const executor = meshJobWorkers({ minFreeGb: 0, maxJobs: 1, jobTimeoutMs: 800 });
      const keys = async () => {
        const result = await run(executor, 'fixture.count');
        return result?.ok ? Object.keys(result.value) : result;
      };
      expect(await keys()).toEqual(['mesh/n1']);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // The same Worker served both builds: a deadline that outlived the first job would
      // have ended it, and the second build would be the first of a new Worker.
      expect(await keys()).toEqual(['mesh/n2']);
    }, 60_000);

    it('caps a Worker heap at maxHeapMb and keeps serving (falsifier)', () => {
      const capped = workerHeapChild('mesh', 64);
      expect(capped).toMatchObject({ ok: false, code: 'model-capability-unavailable' });
      expect(capped.text).toContain('ERR_WORKER_OUT_OF_MEMORY');
      expect(capped.afterCode).toBe('fixture-failed');
      // The same job fits a roomy heap: the failure above is the limit, not the job.
      expect(workerHeapChild('mesh', 4096)).toMatchObject({
        ok: true,
        afterCode: 'fixture-failed',
      });
    }, 120_000);

    it('lets the process exit once the pool is idle (falsifier)', () => {
      // execFileSync kills the child at its timeout and throws: an idle Worker held ref'd would hang it.
      expect(workerHeapChild('idle', 0, 30_000)).toEqual({ ok: true });
    }, 60_000);

    it('fails the build with the cause when a Worker throws outside the job (falsifier)', async () => {
      const executor = meshJobWorkers({ minFreeGb: 0, maxJobs: 1 });
      const result = await run(executor, 'fixture.late');
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'model-capability-unavailable' },
      });
      expect(JSON.stringify(result)).toContain('late');
      expect(await run(executor, 'fixture.fail')).toMatchObject({
        ok: false,
        error: { code: 'fixture-failed' },
      });
    }, 60_000);

    it('maxQueue 0 serves what an idle Worker takes and refuses what would wait (falsifier)', async () => {
      const executor = meshJobWorkers({ minFreeGb: 0, maxJobs: 1, maxQueue: 0 });
      expect(await run(executor, 'fixture.fail')).toMatchObject({
        ok: false,
        error: { code: 'fixture-failed' },
      });
      const running = run(executor, 'fixture.hang', { ms: 1500 });
      expect(await run(executor, 'fixture.fail')).toMatchObject({
        ok: false,
        error: { code: 'model-work-budget' },
      });
      expect(await running).toMatchObject({ ok: true });
      expect(await run(executor, 'fixture.fail')).toMatchObject({
        ok: false,
        error: { code: 'fixture-failed' },
      });
    }, 60_000);

    it('rejects a deadline Node would fire after 1 ms, and accepts the largest valid one (falsifier)', async () => {
      for (const jobTimeoutMs of [2 ** 31, 1e10]) {
        const result = await run(meshJobWorkers({ minFreeGb: 0, jobTimeoutMs }), 'fixture.fail');
        expect(result, String(jobTimeoutMs)).toMatchObject({
          ok: false,
          error: { code: 'model-invalid-argument' },
        });
      }
      const largest = meshJobWorkers({ minFreeGb: 0, jobTimeoutMs: 2 ** 31 - 1 });
      expect(await run(largest, 'fixture.lid', { depth: 0.04 })).toMatchObject({ ok: true });
    }, 60_000);

    it('returns a failure for bad options instead of throwing', async () => {
      for (const bad of [{ maxJobs: 0 }, { maxJobs: 17 }, { jobTimeoutMs: 0 }, { maxQueue: -1 }]) {
        expect(await run(meshJobWorkers(bad), 'fixture.fail')).toMatchObject({
          ok: false,
          error: { code: 'model-invalid-argument' },
        });
      }
    });

    it('refuses a module outside moduleRoots', async () => {
      const executor = meshJobWorkers({ minFreeGb: 0, moduleRoots: [tmpdir()] });
      const result = await run(executor, 'fixture.fail');
      expect(result).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
    });
  });
});
