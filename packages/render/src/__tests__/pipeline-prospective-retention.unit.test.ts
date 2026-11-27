import { ok, type RenderPipeline, type RhiDevice } from '@forgeax/engine-rhi';
import { expect, it, vi } from 'vitest';
import type { LiveRasterBatch } from '../gpu-driven/live-raster';
import type { PreparedRasterPassCache } from '../gpu-driven/prepared-raster-bundle';
import { registerRasterPipelinePreparation } from '../gpu-driven/production-pipeline-preparation';
import type { GpuDrivenGraphProjection } from '../gpu-driven/production-raster';
import type { ProjectedRasterClass } from '../gpu-driven/production-raster-classes';
import type {
  PipelinePreparationJob,
  ProjectedRasterGraph,
  RasterProjectionFrame,
} from '../gpu-driven/production-raster-frame';
import { SourceRasterPreparations } from '../gpu-driven/source-raster-preparation';
import { collectWeakOwners } from './weak-owner-collection-fixture';

it('does not retain prospective batch membership in a live graph after its preparation call', async () => {
  const jobs = new Map<string, PipelinePreparationJob>();
  const ordinary: LiveRasterBatch[] = [];
  const projected = {
    frame: {
      input: {},
      materialPipelineState: {},
    },
  } as unknown as ProjectedRasterGraph;
  const classFor = vi.fn(() => undefined);
  registerRasterPipelinePreparation(
    projected,
    jobs,
    () => null,
    {
      formats: ['rgba8unorm'],
      filter: undefined,
      fragmentEntryPoint: undefined,
      coverageOnly: false,
      sampleCount: 1,
      seededDepth: false,
    },
    () => ordinary,
    classFor,
  );
  const prepare = [...jobs.values()][0];
  expect(prepare).toBeDefined();
  const retired = (() => {
    // The array is the exact membership owner supplied by a prospective Source.
    // No Source or native preparation support is claimed by this lifetime check.
    const membership: LiveRasterBatch[] = [];
    expect(Array.from(prepare?.sourceRequests(membership) ?? [])).toEqual([]);
    return new WeakRef(membership);
  })();
  await collectWeakOwners();
  expect(retired.deref()).toBeUndefined();
  expect(jobs.size).toBe(1);
  expect(prepare?.prepare([], undefined, undefined, undefined)).toBe(true);
  expect(classFor).not.toHaveBeenCalled();
});

it('exposes separately launchable prospective pipeline requests from the actual graph job', () => {
  const jobs = new Map<string, PipelinePreparationJob>();
  const projected = {
    frame: { input: {}, materialPipelineState: {} },
  } as unknown as ProjectedRasterGraph;
  const first = {} as LiveRasterBatch;
  const second = {} as LiveRasterBatch;
  const native = {} as RenderPipeline;
  const left = vi.fn(() => ok(native));
  const right = vi.fn(() => ok(native));
  registerRasterPipelinePreparation(
    projected,
    jobs,
    () => null,
    {
      formats: ['rgba8unorm'],
      filter: undefined,
      fragmentEntryPoint: undefined,
      coverageOnly: false,
      sampleCount: 4,
      seededDepth: false,
    },
    () => [],
    (batch) =>
      ({
        artifact: { material: 'forgeax::default-unlit' },
        pipelines: { pipelineFor: batch === first ? left : right },
      }) as unknown as ProjectedRasterClass,
  );
  const [job] = jobs.values();
  if (job === undefined) throw Error('The actual graph registered no pipeline preparation');
  const [prepareFirst, prepareSecond] = job.sourceRequests([first, second, first]);
  expect(left).not.toHaveBeenCalled();
  expect(right).not.toHaveBeenCalled();
  expect(prepareFirst?.()).toBe(true);
  expect(left).toHaveBeenCalledExactlyOnceWith(['rgba8unorm'], 'rgba8unorm', true, 4, false);
  expect(right).not.toHaveBeenCalled();
  expect(prepareSecond?.()).toBe(true);
  expect(right).toHaveBeenCalledExactlyOnceWith(['rgba8unorm'], 'rgba8unorm', true, 4, false);
});

it('yields between cold class projections and rejects a stale resume before touching the next batch', () => {
  const preparations = new SourceRasterPreparations({} as RhiDevice, {} as PreparedRasterPassCache);
  const batches = ['one', 'two'].map(
    (recordingClassKey) => ({ recordingClassKey }) as LiveRasterBatch,
  );
  const frame = { liveRasterBatches: batches } as RasterProjectionFrame;
  const projected = {
    frame,
    target: { rendererRecording: true },
    rasterClasses: new Map(),
  } as unknown as ProjectedRasterGraph;
  const source = {} as GpuDrivenGraphProjection;
  const job: PipelinePreparationJob = { prepare: () => true, sourceRequests: () => [] };
  let current = true;
  preparations.issue(
    source,
    frame,
    () => current,
    () => current,
  );
  const project = vi.fn(() => true);
  const work = preparations.prepare(
    source,
    projected,
    new Map([['opaque', job]]),
    () => true,
    project,
  );

  expect(project).not.toHaveBeenCalled();
  expect(work.next()).toMatchObject({ done: false });
  expect(project).toHaveBeenCalledExactlyOnceWith(batches[0], frame);

  current = false;
  const stopped = work.next();
  expect(stopped).toMatchObject({
    done: true,
    value: { ok: false, error: { code: 'rhi-descriptor-invalid' } },
  });
  expect(project).toHaveBeenCalledTimes(1);
});
