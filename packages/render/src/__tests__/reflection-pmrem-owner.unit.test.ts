import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { createPrefilterUniformsBuffer, writeAllPrefilterUniforms } from '../device/gpu-residency';
import { createPmremPipeline, pmremExtent, pmremLevelCount } from '../ibl/pmrem';
import type { RenderSystemInternals } from '../record/render-context';
import type { ReflectionProbeFact } from '../reflection/projection';
import { ReflectionProbeRecordOwner } from '../reflection/record-owner';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const errors: unknown[] = [];
  const owner = new ReflectionProbeRecordOwner({
    device,
    deviceScope: DeviceScope.create(1, 'pmrem-array-owner-test'),
    errorRegistry: { fire: (error: unknown) => errors.push(error) },
    gpuStore: { getCubemapIbl: () => undefined, getCubemapGpuView: () => undefined },
  } as unknown as RenderSystemInternals);
  const internal = owner as unknown as {
    ensurePipelineWarmup(): void;
    shared: NonNullable<ReturnType<ReflectionProbeRecordOwner['createSharedResources']>>;
  };
  vi.spyOn(internal, 'ensurePipelineWarmup').mockImplementation(() => {});
  const installShared = () => {
    const pipeline = createPmremPipeline(
      device,
      createShaderModuleImmediate(device, { code: 'native-null-structural-fixture' }).unwrap(),
      'rgba16float',
    ).unwrap();
    const prefilterUniforms = createPrefilterUniformsBuffer(device, 256).unwrap();
    writeAllPrefilterUniforms(device, prefilterUniforms, 256, 'camera').unwrap();
    internal.shared = {
      background: undefined,
      prefilterUniforms,
      sampler: device.createSampler({}).unwrap(),
      filterPipeline: pipeline.pipeline,
      prefilterGroup0Bgl: pipeline.parametersLayout,
      prefilterGroup1Bgl: pipeline.inputLayout,
    };
  };
  installShared();
  let frame = 0;
  const prepare = (facts: readonly ReflectionProbeFact[]) =>
    owner.prepare(
      facts,
      new Map(
        facts.map((fact) => [
          `${fact.entityKey}`,
          { kind: 'probe' as const, entityKey: fact.entityKey, normalizedDistance: 0.25 },
        ]),
      ),
      undefined,
      ++frame,
    );
  return { device, owner, errors, prepare, installShared };
}
function fact(entityKey: number): ReflectionProbeFact {
  return {
    entityKey,
    center: [0, 0, 0],
    halfExtents: [2, 2, 2],
    intensity: 1,
    priority: 0,
    resolution: 16,
    revision: 1,
    updateIntent: 'once',
  };
}
const cycle = 6 + pmremLevelCount(16) * 3;

it('uses one candidate cycle and one shared scratch, and publishes each accepted probe only after completion', async () => {
  const f = await fixture(),
    facts = [fact(1), fact(2)];
  try {
    for (let step = 0; step < cycle * 2; step++) {
      const state = f.prepare(facts);
      expect(state.graph.work).toHaveLength(1);
      expect(state.graph.work[0]?.probeIndex).toBe(step < cycle ? 0 : 1);
      expect(state.graph.work[0]?.filteredArrayLayers).toBe(3);
      expect(state.table.rows).toHaveLength(Math.floor(step / cycle));
      await state.completeSubmission(true, Promise.resolve(), undefined, false);
    }
    const settled = f.prepare(facts);
    expect(settled.graph.work).toHaveLength(0);
    expect(settled.table.rows).toHaveLength(2);
    const rows = settled.table.rows.map((row) => row.pmremArray);
    expect(rows[0]?.view).toBe(rows[1]?.view);
    expect(rows.map((row) => row?.layer)).toEqual([0, 1]);
    const bytes = pmremExtent(16).width * pmremExtent(16).height * 8;
    expect(f.owner.inspect().pmremArrays).toMatchObject({
      activeBytes: 3 * bytes,
      scratchBytes: bytes,
      totalBytes: 4 * bytes,
    });
    expect(f.errors).toEqual([]);
  } finally {
    f.owner.dispose();
  }
});

it('retains old mappings through growth/abort, then uses a spare layer for a continuous update', async () => {
  const f = await fixture(),
    facts = [fact(1), fact(2)];
  try {
    for (let i = 0; i < cycle * 2; i++)
      await f.prepare(facts).completeSubmission(true, Promise.resolve(), undefined, false);
    const old = f.prepare(facts).table.rows[0]?.pmremArray;
    const growth = f.prepare([...facts, fact(3)]);
    expect(growth.graph.work).toEqual([]);
    expect(growth.graph.migrations).toHaveLength(1);
    expect(growth.table.rows[0]?.pmremArray?.view).toBe(old?.view);
    await growth.completeSubmission(false, undefined, undefined, false);
    const retry = f.prepare([...facts, fact(3)]);
    expect(retry.graph.migrations).toHaveLength(1);
    await retry.completeSubmission(true, Promise.resolve(), undefined, false);
    const next = f.prepare([...facts, fact(3)]);
    expect(next.table.rows[0]?.pmremArray?.view).not.toBe(old?.view);
    expect(next.table.rows[0]?.generation).toBe(1);
    await next.completeSubmission(true, Promise.resolve(), undefined, false);
    for (let i = 1; i < cycle; i++)
      await f
        .prepare([...facts, fact(3)])
        .completeSubmission(true, Promise.resolve(), undefined, false);
    const active = f.prepare([...facts, fact(3)]).table.rows[0]?.pmremArray;
    const continuous = [{ ...fact(1), updateIntent: 'continuous' as const }, fact(2), fact(3)];
    const first = f.prepare(continuous);
    expect(first.table.rows[0]?.pmremArray?.layer).toBe(active?.layer);
    expect(first.graph.work[0]?.filteredLayer).not.toBe(active?.layer);
    await first.completeSubmission(false, undefined, undefined, false);
    for (let i = 0; i < cycle; i++)
      await f.prepare(continuous).completeSubmission(true, Promise.resolve(), undefined, false);
    const promoted = f.prepare([fact(1), fact(2), fact(3)]);
    expect(promoted.table.rows[0]?.generation).toBe(2);
    expect(promoted.table.rows[0]?.pmremArray?.layer).not.toBe(active?.layer);
    expect(f.errors).toEqual([]);
  } finally {
    f.owner.dispose();
  }
});

it('keeps a lower-resolution LKG until a new-resolution capture is completely accepted', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < cycle; i++)
      await f.prepare([fact(1)]).completeSubmission(true, Promise.resolve(), undefined, false);
    const changed = { ...fact(1), resolution: 32 };
    const first = f.prepare([changed]);
    expect(first.table.rows[0]?.pmremArray?.size).toBe(16);
    expect(first.graph.work[0]?.filteredSize).toBe(32);
    await first.completeSubmission(true, Promise.resolve(), undefined, false);
    const changedCycle = 6 + pmremLevelCount(32) * 3;
    for (let i = 1; i < changedCycle; i++)
      await f.prepare([changed]).completeSubmission(true, Promise.resolve(), undefined, false);
    const published = f.prepare([changed]);
    expect(published.table.rows[0]?.pmremArray?.size).toBe(32);
    expect(published.table.rows[0]?.generation).toBe(2);
    expect(f.errors).toEqual([]);
  } finally {
    f.owner.dispose();
  }
});

it('bounds rapid resize retirement and reuses the producer after reset', async () => {
  const f = await fixture();
  let release!: () => void;
  const fence = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  vi.spyOn(f.device.queue, 'onSubmittedWorkDone').mockReturnValue(fence);
  let blocked = false;
  try {
    for (let i = 0; i < 32; i++) {
      const state = f.prepare([{ ...fact(1), resolution: i % 2 === 0 ? 256 : 128 }]);
      await state.completeSubmission(false, undefined, undefined, false);
      const inspection = f.owner.inspect();
      const bytes = (inspection.pmremArrays?.totalBytes ?? 0) + (inspection.rawCaptureBytes ?? 0);
      expect(bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      blocked ||=
        inspection.lastResourceAdmission === 'waiting-for-retirement' ||
        inspection.pmremArrays?.admissionFailure === 'byte-budget';
    }
    expect(blocked).toBe(true);
    release();
    await fence;
    await Promise.resolve();
    f.owner.dispose();
    f.installShared();
    const restarted = f.prepare([fact(1)]);
    expect(restarted.graph.work).toHaveLength(1);
    expect(restarted.table.rows).toHaveLength(0);
    expect(f.errors).toEqual([]);
  } finally {
    release();
    f.owner.dispose();
  }
});
