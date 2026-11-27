import { mat4 } from '@forgeax/engine-math';
import { err, RhiError } from '@forgeax/engine-rhi';
import type { MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import {
  GPU_SCENE_PRIMITIVE_MOTION_INVALID,
  GPU_SCENE_PRIMITIVE_NO_SHADOW_RECEIVE,
  GpuScene,
} from '../gpu-scene';
import { PrimitiveAllocations } from '../gpu-scene-allocations';
import type { GpuSceneCapacityPreparation } from '../gpu-scene-capacity';
import type { GpuSceneInputPreparation } from '../gpu-scene-inputs';
import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from '../gpu-scene-schema';
import { captureMaterialSnapshot, MaterialResource } from '../material-resource';
import { worldRenderResources } from '../publication/resource-scope';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { MeshFrame } from '../scene/mesh-frame';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { finishRendererInput, rendererInputHandoffFixture } from './renderer-input-handoff-fixture';

const unrelatedMeshHandle = 50001;

it.each([
  'single',
  'instances',
  'temporal',
  'changed-content',
  'detachment-retry',
  'input-pairing',
  'old-world-dirtiness',
  'unrelated-scene-change',
  'premature-data',
  'premature-inputs',
] as const)('consumes prepared %s Scene Data and reuses its rows and packed versions on ordinary sync', async (mode) => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const result = await f.close();
    if (!result.ok) throw result.error;
  });
  const owner = f.internals.sceneComposition?.entry?.projection;
  assert(owner);
  const original = owner.slotsSnapshot().at(0)?.snapshot;
  assert(original?.assetHandle !== undefined);
  const material = new MaterialResource(captureMaterialSnapshot(original.material.snapshot));
  const row = owner.prepareRow({
    ...original,
    entityKey: 1 << 20,
    material,
    materials: [material],
    materialOverrides: [material],
    ...(mode !== 'instances'
      ? {}
      : {
          instances: {
            transforms: new Float32Array([
              ...mat4.identity(mat4.create()),
              ...mat4.identity(mat4.create()),
            ]),
            instanceCount: 2,
            cacheKey: 1,
            archVersion: 0,
            revision: 1,
          },
        }),
  });
  const source = worldRenderResources(f.world);
  const asset = source.resolveAsset<MeshAsset>(original.assetHandle).unwrap();
  const revision = source.assetRevision(original.assetHandle);
  assert(revision !== undefined);
  let capacity: GpuSceneCapacityPreparation | undefined;
  let input: GpuSceneInputPreparation | undefined;
  let accepted = false;
  let published = false;
  const identity = row.row;
  const work = f.scene.prepareSourceRows(
    [identity],
    (value) => {
      capacity = value;
    },
    () => row.isCurrent(),
    [{ handle: original.assetHandle, asset, identity: source.identity, revision }],
  );
  try {
    if (mode === 'premature-data' || mode === 'premature-inputs') {
      assertPrematureSourceRefused(f, work, () => capacity, mode);
      return;
    }
    finishSourceWork(work);
    assert(capacity);
    const data = f.scene.prepareSourceData(capacity);
    await advanceDataWithOldWorld(f, capacity, data, mode === 'old-world-dirtiness');
    if (mode === 'unrelated-scene-change') {
      const materialFrame = Reflect.get(f.scene, 'materialFrame') as MaterialFrame;
      const liveMaterial = materialFrame.get(original.material);
      assert(liveMaterial !== undefined);
      f.scene
        .sync({
          ...owner.apply([]),
          meshes: owner.meshFrame().with(unrelatedMeshHandle, asset),
          materials: materialFrame.with(original.material, liveMaterial.bindings + 1),
        })
        .unwrap();
      expect(capacity.isValid()).toBe(true);
    }
    const resources = f.scene.sourceResourceAllocations(capacity);
    const prepared = f.scene.sourceRowAllocations(capacity).at(0);
    assert(prepared);
    const inputs = f.scene.prepareSourceInputs(
      capacity,
      (value) => {
        input = value;
      },
      () => row.isCurrent(),
    );
    finishSourceWork(inputs);
    assert(input);
    finishRendererInput(input);
    finishCapacityCopy(capacity);
    const extent = f.scene.preparedAddressExtent(capacity);
    assert(extent !== undefined);
    finishSourceWork(f.manager.prepareAddressCapacity(f.scene, extent, () => row.isCurrent()));
    const target = f.scene.prepareCapacityBindingTarget(capacity).unwrap();
    const binding = f.manager.prepareInputBindings(f.scene, input, target).unwrap();
    binding.publish().unwrap();
    accepted = true;
    if (mode === 'unrelated-scene-change') {
      const acceptedMeshes = Reflect.get(f.scene, 'meshes') as MeshFrame;
      expect(acceptedMeshes.get(unrelatedMeshHandle)).toBeDefined();
    }
    expect(f.scene.primitiveIndexForSlot(identity.slot)).toBe(prepared.recordIndex);
    if (mode === 'single') assertCurrentWithoutStamp(f.scene, capacity);
    expect(f.scene.materialIndexForResource(material)).toBe(resources.materials[0]?.descriptor);
    const held = f.scene.captureResources().unwrap();
    expect(held.indexForResource(material, material.snapshot)).toBe(
      resources.materials[0]?.descriptor,
    );
    held.seal().unwrap();
    held.release();
    if (mode === 'input-pairing') {
      assertInputPairing(f, capacity);
      return;
    }
    if (mode === 'detachment-retry') {
      assertDetachmentRetry(f, capacity, material);
      return;
    }
    const delta = row.publish(prepared);
    published = true;
    const record = delta.createdSlots[0];
    assert(record);
    let ordinary = delta;
    if (mode === 'changed-content') {
      ordinary = owner.apply([
        {
          kind: 'update',
          entityKey: identity.entityKey,
          snapshot: { ...record.snapshot, shadowReceiver: false },
        },
      ]);
      const changed = ordinary.updatedSlots[0];
      assert(changed);
      expect(f.scene.acceptSourceRow(capacity, 0, changed).ok).toBe(false);
    }
    f.scene.acceptSourceRow(capacity, 0, record).unwrap();
    const materialFrame = Reflect.get(f.scene, 'materialFrame') as MaterialFrame;
    const next = materialFrame.with(material, 1, material.snapshot);
    const creates = vi.spyOn(f.internals.device, 'createBuffer');
    const writes = vi.spyOn(f.internals.device.queue, 'writeBuffer');
    try {
      const temporal = vi.fn((row: RenderSceneSlot) => owner.temporalSnapshotBySlot(row.slot));
      const synced = f.scene
        .sync(
          { ...ordinary, meshes: owner.meshFrame(), materials: next },
          mode === 'temporal' ? temporal : undefined,
        )
        .unwrap();
      if (mode === 'temporal' || mode === 'changed-content') {
        assertDirtySourceSync(f.scene, prepared.recordIndex, mode, synced.bytes, temporal);
      } else {
        expect(synced).toMatchObject({ bytes: 0, ranges: 0, grew: false });
        expect(writes).not.toHaveBeenCalled();
      }
      expect(creates).not.toHaveBeenCalled();
      expect(f.scene.primitiveIndexForSlot(identity.slot)).toBe(prepared.recordIndex);
      expect(f.scene.materialIndexForResource(material)).toBe(resources.materials[0]?.descriptor);
    } finally {
      creates.mockRestore();
      writes.mockRestore();
    }
  } finally {
    if (published) {
      assert(capacity);
      f.scene.sync(owner.apply([{ kind: 'remove', entityKey: identity.entityKey }])).unwrap();
      expect(f.scene.sourceDataCurrent(capacity)).toBe(false);
    } else if (accepted && capacity?.inspect().phase !== 'retired') {
      assert(capacity);
      f.scene.detachSourceData(capacity).unwrap();
    }
    row.release();
    input?.release();
    work.return(undefined as never);
    await f.internals.device.queue.onSubmittedWorkDone();
    if (capacity !== undefined)
      for (let step = 0; !capacity.retireStep() && step < 1000; step++) {
        /* detached resource custody */
      }
  }
});

function assertDirtySourceSync(
  scene: GpuScene,
  recordIndex: number,
  mode: 'temporal' | 'changed-content',
  writtenBytes: number,
  temporal: unknown,
): void {
  expect(writtenBytes).toBeGreaterThan(0);
  const bytes = Reflect.get(scene, 'tableBytes').primitive as Uint8Array;
  const flags = new DataView(bytes.buffer).getUint32(
    recordIndex * GPU_SCENE_LAYOUTS.primitive.stride +
      gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'flags'),
    true,
  );
  expect(
    flags &
      (mode === 'temporal'
        ? GPU_SCENE_PRIMITIVE_MOTION_INVALID
        : GPU_SCENE_PRIMITIVE_NO_SHADOW_RECEIVE),
  ).not.toBe(0);
  if (mode === 'temporal') expect(temporal).toHaveBeenCalled();
}

function assertCurrentWithoutStamp(scene: GpuScene, capacity: GpuSceneCapacityPreparation): void {
  const stamp = vi.spyOn(PrimitiveAllocations.prototype, 'stamp');
  try {
    expect(scene.sourceDataCurrent(capacity)).toBe(true);
    expect(stamp).not.toHaveBeenCalled();
  } finally {
    stamp.mockRestore();
  }
}

function finishSourceWork<T>(work: Generator<void, T>): T {
  for (let step = 0; step < 1000; step++) {
    const result = work.next();
    if (result.done) return result.value;
  }
  throw new Error('Source test preparation did not complete within its original step bound');
}

function assertPrematureSourceRefused(
  f: Awaited<ReturnType<typeof rendererInputHandoffFixture>>,
  work: Generator<void, GpuSceneCapacityPreparation>,
  captured: () => GpuSceneCapacityPreparation | undefined,
  mode: 'premature-data' | 'premature-inputs',
): void {
  const observed = new Set<string>();
  for (let step = 0; step < 1000; step++) {
    const advanced = work.next();
    expect(advanced.done).toBe(false);
    const capacity = captured();
    if (capacity === undefined) continue;
    const phase =
      f.scene.sourceRowAllocations(capacity).length === 0
        ? 'reserving'
        : capacity.inspect().privateWriteBytes === 0
          ? 'reserved'
          : 'encoding';
    if (observed.has(phase)) continue;
    if (phase === 'reserving') {
      // The replacement cannot copy until the reserved addresses are known.
      expect(capacity.isValid()).toBe(false);
    } else {
      if (!capacity.isValid()) continue;
      // Copy completion is independent from the still-running Source iterator.
      finishCapacityCopy(capacity);
      expect(capacity.isCurrent()).toBe(true);
    }
    let inputCaptured = false;
    const premature =
      mode === 'premature-data'
        ? f.scene.prepareSourceData(capacity)
        : f.scene.prepareSourceInputs(
            capacity,
            () => {
              inputCaptured = true;
            },
            () => true,
          );
    try {
      expect(() => premature.next()).toThrow();
      expect(inputCaptured).toBe(false);
      const target = f.scene.prepareCapacityBindingTarget(capacity);
      if (phase === 'reserving') expect(target.ok).toBe(false);
      else expect(f.scene.canPublishCapacityTarget(target.unwrap())).toBe(false);
    } finally {
      premature.return(undefined as never);
    }
    observed.add(phase);
    if (observed.size === 3) return;
  }
  throw new Error('Source reserve/encode boundaries were not all observed before completion');
}

async function advanceDataWithOldWorld(
  f: Awaited<ReturnType<typeof rendererInputHandoffFixture>>,
  capacity: GpuSceneCapacityPreparation,
  data: Generator<void>,
  running: boolean,
): Promise<void> {
  if (running) {
    expect(data.next().done).toBe(false);
    expect((await f.draw()).presentation).toBe('ready');
    expect(capacity.isValid()).toBe(true);
    expect(capacity.isCurrent()).toBe(false);
  }
  finishSourceWork(data);
  if (running) {
    expect((await f.draw()).presentation).toBe('ready');
    expect(capacity.isValid()).toBe(true);
    expect(capacity.isCurrent()).toBe(false);
  }
}

function finishCapacityCopy(capacity: GpuSceneCapacityPreparation): void {
  for (let step = 0; step < 1000; step++) {
    if (capacity.isCurrent()) return;
    capacity.step().unwrap();
  }
  throw new Error('Source numeric catch-up exceeded the original step bound');
}

function assertInputPairing(
  f: Awaited<ReturnType<typeof rendererInputHandoffFixture>>,
  capacity: GpuSceneCapacityPreparation,
): void {
  let replacement: GpuSceneInputPreparation | undefined;
  const work = f.scene.prepareSourceInputs(
    capacity,
    (value) => {
      replacement = value;
    },
    () => true,
  );
  try {
    expect(() => work.next()).toThrow();
    // A failing constructor must not replace the original consumed pairing either.
    expect(replacement === undefined).toBe(true);
  } finally {
    work.return(undefined as never);
    replacement?.release();
  }
}

function assertDetachmentRetry(
  f: Awaited<ReturnType<typeof rendererInputHandoffFixture>>,
  capacity: GpuSceneCapacityPreparation,
  material: MaterialResource,
): void {
  const descriptor = f.scene.materialIndexForResource(material);
  assert(descriptor !== undefined);
  const failure = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'a successful Source detachment upload',
    hint: 'retry the outstanding clear before releasing Source custody',
  });
  const writes = vi
    .spyOn(f.internals.device.queue, 'writeBuffer')
    .mockReturnValueOnce(err(failure));
  try {
    const detached = f.scene.detachSourceData(capacity);
    expect(detached.ok).toBe(false);
    if (!detached.ok) expect(detached.error).toBe(failure);
  } finally {
    writes.mockRestore();
  }
  try {
    let retired = false;
    for (let step = 0; step < 32; step++) retired = capacity.retireStep() || retired;
    expect(retired).toBe(false);
    expect(f.scene.materialIndexForResource(material)).toBe(descriptor);
  } finally {
    if (capacity.inspect().phase !== 'retired') f.scene.detachSourceData(capacity).unwrap();
  }
}

it('retains authored material ranges when standalone ordinary consumption has no MaterialFrame', async () => {
  const f = await rendererInputHandoffFixture();
  const available = GpuScene.create(f.internals.device, 256, f.internals.shaderRegistry).unwrap();
  assert(available.status === 'available');
  const scene = available.scene;
  onTestFinished(async () => {
    scene.dispose();
    const result = await f.close();
    if (!result.ok) throw result.error;
  });
  const owner = f.internals.sceneComposition?.entry?.projection;
  assert(owner);
  scene.sync({ ...owner.apply([]), meshes: owner.meshFrame() }).unwrap();
  const original = owner.slotsSnapshot().at(0)?.snapshot;
  assert(original?.assetHandle !== undefined);
  const first = new MaterialResource(captureMaterialSnapshot(original.material.snapshot));
  const extra = new MaterialResource(captureMaterialSnapshot(original.material.snapshot));
  const row = owner.prepareRow({
    ...original,
    entityKey: 1 << 20,
    material: first,
    materials: [first, extra],
    materialOverrides: [first, extra],
  });
  const source = worldRenderResources(f.world);
  const asset = source.resolveAsset<MeshAsset>(original.assetHandle).unwrap();
  const revision = source.assetRevision(original.assetHandle);
  assert(revision !== undefined);
  let capacity: GpuSceneCapacityPreparation | undefined;
  let input: GpuSceneInputPreparation | undefined;
  let published = false;
  let accepted = false;
  const identity = row.row;
  const work = scene.prepareSourceRows(
    [identity],
    (value) => {
      capacity = value;
    },
    () => row.isCurrent(),
    [{ handle: original.assetHandle, asset, identity: source.identity, revision }],
  );
  try {
    finishSourceWork(work);
    assert(capacity);
    const data = scene.prepareSourceData(capacity);
    finishSourceWork(data);
    const inputs = scene.prepareSourceInputs(
      capacity,
      (value) => {
        input = value;
      },
      () => row.isCurrent(),
    );
    finishSourceWork(inputs);
    assert(input);
    finishRendererInput(input);
    const target = scene.prepareCapacityBindingTarget(capacity).unwrap();
    expect(scene.canPublishCapacityTarget(target, input)).toBe(true);
    input.commitPrepared().unwrap();
    scene.publishCapacityTarget(target).unwrap();
    accepted = true;
    const prepared = scene.sourceRowAllocations(capacity).at(0);
    assert(prepared);
    expect(prepared.snapshot.materials).toHaveLength(1);
    const delta = row.publish(prepared);
    published = true;
    const record = delta.createdSlots[0];
    assert(record);
    expect(record.snapshot.materials).toHaveLength(2);
    scene.acceptSourceRow(capacity, 0, record).unwrap();
    const creates = vi.spyOn(f.internals.device, 'createBuffer');
    const writes = vi.spyOn(f.internals.device.queue, 'writeBuffer');
    try {
      const synced = scene.sync({ ...delta, meshes: owner.meshFrame() }).unwrap();
      expect(synced).toMatchObject({ bytes: 0, ranges: 0, grew: false });
      expect(writes).not.toHaveBeenCalled();
      expect(creates).not.toHaveBeenCalled();
      expect(scene.instanceIndexForSlot(record.slot, 0)).toBe(prepared.instanceStart);
      expect(
        scene.sourceResourceAllocations(capacity).materials.map((claim) => claim.resource),
      ).toContain(extra);
    } finally {
      creates.mockRestore();
      writes.mockRestore();
    }
  } finally {
    if (published)
      scene.sync(owner.apply([{ kind: 'remove', entityKey: identity.entityKey }])).unwrap();
    else if (accepted && capacity !== undefined) scene.detachSourceData(capacity).unwrap();
    row.release();
    input?.release();
    work.return(undefined as never);
    await f.internals.device.queue.onSubmittedWorkDone();
    if (capacity !== undefined)
      for (let step = 0; !capacity.retireStep() && step < 1000; step++) {
        /* exact claims */
      }
  }
});
