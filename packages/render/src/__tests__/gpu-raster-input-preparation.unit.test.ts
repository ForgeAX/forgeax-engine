import type { BindGroupDescriptor } from '@forgeax/engine-rhi';
import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { assert, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { LiveRasterBatch, LiveRasterCache } from '../gpu-driven/live-raster';
import { PreparedRasterBundleCache } from '../gpu-driven/prepared-raster-bundle';
import {
  type ProductionRasterInputs,
  prepareProductionRasterInputs,
} from '../gpu-driven/production-raster-inputs';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { RetainedRasterEncodes } from '../gpu-driven/retained-raster-encode';
import type { GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import { standardPbrInputs } from './gpu-driven-production-fixture';
import { collectWeakOwners } from './weak-owner-collection-fixture';

async function fixture(whole = true, manualCleanup = false) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  Object.defineProperty(device, 'caps', {
    value: { ...device.caps, firstInstanceIndirect: whole },
  });
  const buffer = () => device.createBuffer({ size: 4096, usage: 128 | 8 }).unwrap();
  const visible = buffer();
  const shadow = buffer();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const standard = standardPbrInputs(device, shader, layout);
  assert(standard.materialPipelineState !== undefined && standard.materialArtifact !== undefined);
  const raster = MaterialAbiRasterAdapter.create({
    device,
    pipelineState: standard.materialPipelineState,
    artifact: standard.materialArtifact,
    visibleBuffer: visible,
  }).unwrap();
  const available = GpuScene.create(device, 256).unwrap();
  assert(available.status === 'available');
  const scene = available.scene;
  const read = scene.inputs.capture();
  const previous = read.buffer().unwrap();
  read.seal().unwrap();
  raster.ensureSceneTables(
    scene.transformBuffer,
    scene.transformByteLength,
    scene.instanceBuffer,
    scene.rowCapacity * GPU_SCENE_LAYOUTS.instance.stride,
    scene.primitiveBuffer,
    scene.rowCapacity * GPU_SCENE_LAYOUTS.primitive.stride,
    undefined,
    previous.buffer,
    scene.inputs,
  );
  const mainA = raster.visibleWindowBindGroupForBuffer(visible, 0, 64).unwrap();
  const mainB = raster.visibleWindowBindGroupForBuffer(visible, 64, 64).unwrap();
  const shadowA = raster.shadowVisibleWindowBindGroupForBuffer(shadow, 64, 64).unwrap();
  const preparation = scene.inputs.prepareBuffer().unwrap();
  for (let step = 0; step < 1000 && !preparation.isCurrent(); step++) preparation.step(64).unwrap();
  expect(preparation.isCurrent()).toBe(true);
  const createNative = device.createBindGroup.bind(device);
  const create = vi.spyOn(device, 'createBindGroup');
  const dispose = async () => {
    create.mockRestore();
    raster.dispose();
    preparation.release();
    read.release();
    scene.dispose();
    await device.queue.onSubmittedWorkDone();
    device.destroyBuffer(visible).unwrap();
    device.destroyBuffer(shadow).unwrap();
  };
  if (!manualCleanup) onTestFinished(dispose);
  return {
    device,
    buffer,
    raster,
    scene,
    preparation,
    visible,
    shadow,
    mainA,
    mainB,
    shadowA,
    create,
    createNative,
    dispose,
  };
}

function inputBuffer(descriptor: BindGroupDescriptor) {
  const resource = Array.from(descriptor.entries).find((entry) => entry.binding === 8)?.resource;
  assert(resource?.kind === 'buffer');
  return resource.value.buffer;
}

describe('Production raster Inputs publication', () => {
  function prepareProduction(
    f: Awaited<ReturnType<typeof fixture>>,
    count: number,
    capture = (_row: LiveRasterBatch) => {},
  ) {
    const rows = Array.from({ length: count }, () => ({
      batch: {},
      visibleBindGroups: new Map([[undefined, { early: [f.mainA] }]]),
      bundles: new PreparedRasterBundleCache(),
    })) as unknown as readonly LiveRasterBatch[];
    const main = {
      visibleBuffer: f.visible,
      rigidBindings: f.raster.visibleBindingIdentity,
      value: rows,
    } as unknown as LiveRasterCache;
    const state: ProductionRasterInputs = {
      rigid: f.raster,
      skin: undefined,
      main,
      shadows: new Map(),
      shadowSources: new WeakMap(),
      unchanged: new Map(),
      retained: new RetainedRasterEncodes(),
    };
    const first = rows[0];
    assert(first !== undefined);
    capture(first);
    const view = { visibleBuffer: f.visible, skinTaskBinding: () => undefined } as GpuDrivenView;
    const read = vi.fn(() => state);
    const accept = vi.fn();
    const result = prepareProductionRasterInputs(
      f.scene,
      { kind: 'successor', preparation: f.preparation },
      [view],
      read,
      accept,
      () => true,
    );
    return { read, accept, result };
  }

  it('qualifies the Production root independently of the number of private bundle variants', async () => {
    const f = await fixture();
    const one = prepareProduction(f, 1);
    one.result.unwrap().release();
    const many = prepareProduction(f, 128);
    many.result.unwrap().release();
    expect(many.read.mock.calls.length).toBe(one.read.mock.calls.length);
  });

  it('rejects a live window edited by a native callback before private preparation returns', async () => {
    const f = await fixture();
    const { accept, result } = prepareProduction(f, 1, (row) => {
      f.create.mockImplementationOnce((descriptor) => {
        row.visibleBindGroups = new Map([[undefined, { early: [f.mainB] }]]);
        return f.createNative(descriptor);
      });
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'rhi-descriptor-invalid' } });
    expect(accept).not.toHaveBeenCalled();
    const retried = prepareProduction(f, 1).result.unwrap();
    expect(retried.isCurrent()).toBe(true);
    retried.release();
  });
});

describe('private raster Inputs window preparation', () => {
  it.each([
    true,
    false,
  ])('prebuilds exact main/shadow windows (whole=%s) without early publication', async (whole) => {
    const f = await fixture(whole);
    const identity = f.raster.visibleBindingIdentity;
    const task = f.raster
      .prepareInputBindings(f.scene.inputs, { kind: 'successor', preparation: f.preparation }, [
        f.visible,
        f.shadow,
        f.shadow,
      ])
      .unwrap();
    expect(f.create).toHaveBeenCalledTimes(whole ? 2 : 3);
    for (const [descriptor] of f.create.mock.calls)
      expect(inputBuffer(descriptor)).toBe(f.preparation.buffer);
    const nextA = task.replacement(f.mainA);
    const nextB = task.replacement(f.mainB);
    const nextShadow = task.replacement(f.shadowA);
    expect(nextA).toBeDefined();
    expect(nextA).not.toBe(f.mainA);
    expect(nextShadow).not.toBe(f.shadowA);
    expect(f.raster.visibleWindowBindGroupForBuffer(f.visible, 0, 64).unwrap()).toBe(f.mainA);
    expect(f.raster.shadowVisibleWindowBindGroupForBuffer(f.shadow, 64, 64).unwrap()).toBe(
      f.shadowA,
    );
    expect(f.raster.visibleBindingIdentity).toBe(identity);
    expect(task.publish().ok).toBe(false);
    f.preparation.commitPrepared().unwrap();
    expect(task.isCurrent()).toBe(true);
    f.create.mockClear();
    const write = vi.spyOn(f.device.queue, 'writeBuffer');
    task.publish().unwrap();
    expect(f.raster.visibleBindingIdentity).not.toBe(identity);
    expect(f.raster.visibleWindowBindGroupForBuffer(f.visible, 0, 64).unwrap()).toBe(nextA);
    expect(f.raster.visibleWindowBindGroupForBuffer(f.visible, 64, 64).unwrap()).toBe(nextB);
    expect(f.raster.shadowVisibleWindowBindGroupForBuffer(f.shadow, 64, 64).unwrap()).toBe(
      nextShadow,
    );
    expect(f.create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
    expect(task.isCurrent()).toBe(false);
    expect(task.replacement(f.mainA)).toBeUndefined();
    expect(task.publish().ok).toBe(false);
    task.release();
  });

  it('preserves portable window offsets, sizes and shadow visible aliasing', async () => {
    const f = await fixture(false);
    const task = f.raster
      .prepareInputBindings(f.scene.inputs, { kind: 'successor', preparation: f.preparation }, [
        f.shadow,
      ])
      .unwrap();
    const ranges = f.create.mock.calls.map(([desc]) =>
      Array.from(desc.entries)
        .filter((e) => e.binding === 1 || e.binding === 2)
        .map((e) => e.resource),
    );
    expect(ranges).toEqual([
      Array(2).fill({ kind: 'buffer', value: { buffer: f.visible, offset: 0, size: 1024 } }),
      Array(2).fill({ kind: 'buffer', value: { buffer: f.visible, offset: 1024, size: 1024 } }),
      Array(2).fill({ kind: 'buffer', value: { buffer: f.shadow, offset: 1024, size: 1024 } }),
    ]);
    task.release();
  });

  it('rejects copied and foreign Inputs tasks before native creation', async () => {
    const f = await fixture();
    expect(
      f.raster.prepareInputBindings(
        f.scene.inputs,
        { kind: 'successor', preparation: { ...f.preparation } },
        [f.shadow],
      ).ok,
    ).toBe(false);
    const other = GpuScene.create(f.device, 256).unwrap();
    assert(other.status === 'available');
    const foreign = other.scene.inputs.prepareBuffer().unwrap();
    expect(
      f.raster.prepareInputBindings(f.scene.inputs, { kind: 'successor', preparation: foreign }, [
        f.shadow,
      ]).ok,
    ).toBe(false);
    expect(
      f.raster.prepareInputBindings(
        other.scene.inputs,
        { kind: 'successor', preparation: foreign },
        [f.shadow],
      ).ok,
    ).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
    foreign.release();
    other.scene.dispose();
  });

  it('releases all private groups after a partial native failure and permits retry', async () => {
    const f = await fixture(false);
    const original = f.createNative;
    const failure = new RhiError({
      code: 'internal-error',
      expected: 'native group',
      hint: 'retry',
    });
    f.create.mockImplementationOnce(original).mockReturnValueOnce(err(failure));
    const failed = f.raster.prepareInputBindings(
      f.scene.inputs,
      { kind: 'successor', preparation: f.preparation },
      [f.shadow],
    );
    expect(failed).toMatchObject({ ok: false, error: failure });
    expect(f.raster.visibleWindowBindGroupForBuffer(f.visible, 0, 64).unwrap()).toBe(f.mainA);
    const retry = f.raster
      .prepareInputBindings(f.scene.inputs, { kind: 'successor', preparation: f.preparation }, [
        f.shadow,
      ])
      .unwrap();
    retry.release();
  });

  it.each([
    'window',
    'probe',
    'cancel',
    'dispose',
  ] as const)('refuses stale %s facts', async (change) => {
    const f = await fixture(false);
    const task = f.raster
      .prepareInputBindings(f.scene.inputs, { kind: 'successor', preparation: f.preparation }, [
        f.shadow,
      ])
      .unwrap();
    const probe = change === 'probe' ? f.buffer() : undefined;
    if (change === 'window') f.raster.visibleWindowBindGroupForBuffer(f.visible, 128, 64).unwrap();
    else if (probe !== undefined) f.raster.ensureProbeBlendRecordBuffer(probe).unwrap();
    else if (change === 'cancel') f.preparation.release();
    else f.raster.dispose();
    expect(task.isCurrent()).toBe(false);
    f.create.mockClear();
    expect(task.publish().ok).toBe(false);
    expect(task.replacement(f.mainA)).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
    task.release();
    if (probe !== undefined) f.device.destroyBuffer(probe).unwrap();
  });

  it.each([
    'cancel',
    'dispose',
    'throw',
  ] as const)('settles native factory %s before another group', async (action) => {
    const f = await fixture(false);
    const original = f.createNative;
    f.create.mockImplementationOnce((desc) => {
      expect(
        f.raster.prepareInputBindings(
          f.scene.inputs,
          { kind: 'successor', preparation: f.preparation },
          [f.shadow],
        ).ok,
      ).toBe(false);
      if (action === 'throw') throw new Error('factory threw');
      const group = original(desc);
      if (action === 'dispose') f.raster.dispose();
      else f.preparation.release();
      return group;
    });
    if (action === 'throw') {
      expect(() =>
        f.raster.prepareInputBindings(
          f.scene.inputs,
          { kind: 'successor', preparation: f.preparation },
          [f.shadow],
        ),
      ).toThrow('factory threw');
      f.raster
        .prepareInputBindings(f.scene.inputs, { kind: 'successor', preparation: f.preparation }, [
          f.shadow,
        ])
        .unwrap()
        .release();
    } else {
      expect(
        f.raster.prepareInputBindings(
          f.scene.inputs,
          { kind: 'successor', preparation: f.preparation },
          [f.shadow],
        ).ok,
      ).toBe(false);
      expect(f.create).toHaveBeenCalledTimes(1);
    }
  });
});

it.each([
  'publish',
  'release',
  'dispose',
] as const)('drops the actual Material adapter after %s while its closed preparation stays held', async (operation) => {
  const held = await (async () => {
    const f = await fixture(true, true);
    const task = f.raster
      .prepareInputBindings(f.scene.inputs, { kind: 'successor', preparation: f.preparation }, [
        f.shadow,
      ])
      .unwrap();
    const owner = new WeakRef(f.raster);
    try {
      if (operation === 'publish') {
        f.preparation.commitPrepared().unwrap();
        task.publish().unwrap();
      } else if (operation === 'release') task.release();
      else f.raster.dispose();
    } finally {
      await f.dispose();
    }
    return { task, owner };
  })();
  await collectWeakOwners();
  expect(held.owner.deref() === undefined).toBe(true);
  expect(held.task.isCurrent()).toBe(false);
});
