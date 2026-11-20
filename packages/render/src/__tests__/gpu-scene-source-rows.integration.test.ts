import type { EntityHandle } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import type { GpuSceneCapacityPreparation } from '../gpu-scene-capacity';
import {
  GPU_MATERIAL_DESCRIPTOR,
  GPU_MESH_DESCRIPTOR,
  type GpuSceneInputPreparation,
} from '../gpu-scene-inputs';
import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from '../gpu-scene-schema';
import { captureMaterialSnapshot, MaterialResource } from '../material-resource';
import { Materials } from '../materials';
import { worldRenderResources } from '../publication/resource-scope';
import { MeshFrame } from '../scene/mesh-frame';
import type { StableRangeAllocator } from '../stable-range-allocator';
import { observeGpuInputBytes } from './helpers/gpu-input-bytes';
import { rendererInputHandoffFixture } from './renderer-input-handoff-fixture';

const TRANSFORM = GPU_SCENE_LAYOUTS.transform;
const INSTANCE = GPU_SCENE_LAYOUTS.instance;

it.each([
  'defined',
  'unknown',
] as const)('prepares a fully cold custom material only with its actual %s schema', async (mode) => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  const owner = f.internals.sceneComposition?.entry?.projection;
  assert(owner);
  const original = owner.slotsSnapshot().at(0)?.snapshot;
  assert(original);
  const cold = new MaterialResource(
    captureMaterialSnapshot({
      ...original.material.snapshot,
      materialShaderId: 'fixture::cold-source-layout',
      materialParamSchema:
        mode === 'defined'
          ? [
              { name: 'signal', type: 'vec4' },
              { name: 'gain', type: 'f32' },
            ]
          : undefined,
      paramSnapshot: { signal: [0.125, 0.25, 0.5, 1], gain: 7.5 },
    }),
  );
  const row = owner.prepareRow({
    ...original,
    entityKey: 1 << 20,
    material: cold,
    materials: [cold],
  });
  const pipelines = vi.spyOn(f.manager, 'prepareCandidatePipelines');
  let task: GpuSceneCapacityPreparation | undefined;
  const work = f.scene.prepareSourceRows(
    [row.row],
    (issued) => {
      task = issued;
    },
    () => row.isCurrent(),
    meshSources(f, original.assetHandle),
  );
  const finish = () => {
    for (let step = 0; step < 1000; step++) if (work.next().done) return;
    throw Error('cold Data did not settle');
  };
  try {
    if (mode === 'unknown') {
      expect(finish).toThrow();
      return;
    }
    finish();
    assert(task);
    const prepared = f.scene
      .sourceResourceAllocations(task)
      .materials.find((claim) => claim.resource === cold);
    assert(prepared?.payload);
    expect(task.isCurrent()).toBe(true);
    const material = task.preparedTables()?.find((table) => table.name === 'material');
    assert(material);
    const values = new Float32Array(
      material.bytes.buffer,
      material.bytes.byteOffset + prepared.payload.start * 16,
      8,
    );
    expect(Array.from(values.slice(0, 5))).toEqual([0.125, 0.25, 0.5, 1, 7.5]);
    expect(pipelines).not.toHaveBeenCalled();
    cold.adopt(
      captureMaterialSnapshot({
        ...cold.snapshot,
        materialParamSchema: [
          { name: 'gain', type: 'f32' },
          { name: 'signal', type: 'vec4' },
        ],
      }),
    );
    expect(task.isCurrent()).toBe(false);
  } finally {
    pipelines.mockRestore();
    work.return(undefined as never);
    await f.internals.device.queue.onSubmittedWorkDone();
    if (task !== undefined) {
      for (let step = 0; step < 1000 && !task.retireStep(); step++) {
        /* exact cold custody */
      }
      expect(task.inspect().phase).toBe('retired');
    }
    row.release();
  }
});

it('publishes the exact cold GPU-prepared geometry into its reserved Scene row without recapture', async () => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  const owner = f.internals.sceneComposition?.entry?.projection;
  assert(owner);
  const original = owner.slotsSnapshot().at(0)?.snapshot;
  assert(original);
  const handle = f.assets.create(createBoxGeometry(3, 2, 1).unwrap()).unwrap();
  const row = owner.prepareRow({ ...original, entityKey: 1 << 20, assetHandle: handle });
  const identity = row.row;
  let task: GpuSceneCapacityPreparation | undefined;
  const work = f.scene.prepareSourceRows(
    [identity],
    (value) => {
      task = value;
    },
    () => row.isCurrent(),
    meshSources(f, handle),
  );
  let published = false;
  try {
    for (let step = 0; !work.next().done && step < 1000; step++) {
      /* actual Source geometry and private GPU rows */
    }
    assert(task);
    const prepared = f.scene.sourceRowAllocations(task).at(0);
    assert(prepared);
    const read = vi.spyOn(worldRenderResources(f.world), 'resolveAsset');
    const capture = vi.spyOn(MeshFrame.prototype, 'with');
    try {
      const delta = row.publish(prepared);
      published = true;
      expect(read).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
      expect(owner.meshFrame().get(handle)).toBe(prepared.geometry);
      expect(delta.createdSlots[0]).toMatchObject({
        entityKey: identity.entityKey,
        slot: identity.slot,
        generation: identity.generation,
      });
      expect(owner.slot(identity.entityKey)?.snapshot.material).toBe(prepared.snapshot.material);
    } finally {
      read.mockRestore();
      capture.mockRestore();
    }
  } finally {
    if (published) owner.apply([{ kind: 'remove', entityKey: identity.entityKey }]);
    row.release();
    work.return(undefined as never);
    await f.internals.device.queue.onSubmittedWorkDone();
    if (task !== undefined)
      for (let step = 0; !task.retireStep() && step < 1000; step++) {
        /* exact private allocation drain */
      }
  }
});

function meshSources(
  f: Awaited<ReturnType<typeof rendererInputHandoffFixture>>,
  handle: number | undefined,
) {
  assert(handle !== undefined);
  const scope = worldRenderResources(f.world);
  const asset = scope.resolveAsset<MeshAsset>(handle);
  const revision = scope.assetRevision(handle);
  assert(asset.ok && revision !== undefined);
  return [{ handle, asset: asset.value, identity: scope.identity, revision }];
}

it('continues private Inputs construction while ordinary frames dirty its prepared Scene tables', async () => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  const owner = f.internals.sceneComposition?.entry?.projection;
  assert(owner);
  const original = owner.slotsSnapshot().at(0)?.snapshot;
  assert(original);
  const cold = new MaterialResource(captureMaterialSnapshot({ ...original.material.snapshot }));
  const row = owner.prepareRow({
    ...original,
    entityKey: 1 << 20,
    material: cold,
    materials: [cold],
    materialOverrides: [cold],
  });
  let task: GpuSceneCapacityPreparation | undefined;
  let input: GpuSceneInputPreparation | undefined;
  let inputs: Generator<void, GpuSceneInputPreparation> | undefined;
  const rows = f.scene.prepareSourceRows(
    [row.row],
    (value) => {
      task = value;
    },
    () => row.isCurrent(),
    meshSources(f, original.assetHandle),
  );
  try {
    for (let step = 0; !rows.next().done && step < 1000; step++) {
      /* numeric tables */
    }
    assert(task);
    expect(task.isCurrent()).toBe(true);
    inputs = f.scene.prepareSourceInputs(
      task,
      (value) => {
        input = value;
      },
      () => row.isCurrent(),
    );
    expect(inputs.next().done).toBe(false);
    f.world.set(original.entityKey as EntityHandle, Transform, { pos: [0.25, 0, 0] }).unwrap();
    expect((await f.draw()).presentation).toBe('ready');
    expect(task.isCurrent()).toBe(false);
    expect(task.isValid()).toBe(true);
    expect(inputs.next().done).toBe(true);
    assert(input);
    for (let step = 0; step < 1000; step++) {
      if (!task.isCurrent()) task.step().unwrap();
      if (!input.isCurrent()) input.step(64).unwrap();
      if (task.isCurrent() && input.isCurrent()) break;
    }
    expect(task.isCurrent()).toBe(true);
    expect(input.isCurrent()).toBe(true);
    expect(input.privatePageBytes).toBe(4 * 1024);
    expect(f.scene.sourceResourceAllocations(task).materials[0]?.mapping?.isCurrent()).toBe(true);
  } finally {
    inputs?.return(undefined as never);
    input?.release();
    rows.return(undefined as never);
    await f.internals.device.queue.onSubmittedWorkDone();
    if (input !== undefined)
      for (let step = 0; step < 16; step++) if (input.retirement().unwrap().done) break;
    if (task !== undefined)
      for (let step = 0; !task.retireStep() && step < 1000; step++) {
        /* no frame */
      }
    row.release();
  }
});

it('rejects a shared claim released during its actual material schema lookup', async () => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  const owner = f.internals.sceneComposition?.entry?.projection;
  const registry = f.internals.shaderRegistry;
  assert(owner && registry);
  const original = owner.slotsSnapshot().at(0)?.snapshot;
  assert(original);
  const material = original.material;
  material.adopt(
    captureMaterialSnapshot({
      ...material.snapshot,
      materialShaderId: 'fixture::source-owned-schema',
      materialParamSchema: [{ name: 'roughness', type: 'f32' }],
      paramSnapshot: { roughness: 0.7 },
    }),
  );
  const materials = f.internals.sceneComposition?.entry?.materialDispatch.materials();
  assert(materials);
  f.scene
    .sync({ ...owner.apply([]), materials: materials.with(material), materialUpdates: [material] })
    .unwrap();
  const row = owner.prepareRow({ ...original, entityKey: 1 << 20 });
  let task: GpuSceneCapacityPreparation | undefined;
  const work = f.scene.prepareSourceRows(
    [row.row],
    (value) => {
      task = value;
    },
    () => row.isCurrent(),
    meshSources(f, original.assetHandle),
  );
  try {
    for (let step = 0; !work.next().done && step < 1000; step++) {
      /* exact Source preparation */
    }
    assert(task);
    const claim = f.scene.sourceResourceAllocations(task).materials[0];
    assert(claim);
    expect(claim.privateDescriptor).toBeUndefined();
    expect(claim.isCurrent()).toBe(true);
    const lookup = registry.findMaterialArtifact.bind(registry);
    let released = false;
    const spy = vi.spyOn(registry, 'findMaterialArtifact').mockImplementation((...args) => {
      if (!released) {
        released = true;
        claim.release();
      }
      return lookup(...args);
    });
    try {
      expect(claim.isCurrent()).toBe(false);
      expect(released).toBe(true);
      expect(f.scene.inputs.resourceIsCurrent(claim.logicalSlot, claim.descriptor)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  } finally {
    work.return(undefined as never);
    await f.internals.device.queue.onSubmittedWorkDone();
    if (task !== undefined)
      for (let step = 0; !task.retireStep() && step < 1000; step++) {
        /* no frame */
      }
    row.release();
  }
});

it('keeps exact failed constructor custody in the Source task and cannot report retirement after unknown rollback', async () => {
  const f = await rendererInputHandoffFixture();
  const owner = f.internals.sceneComposition?.entry?.projection;
  assert(owner);
  const original = owner.slotsSnapshot().at(0)?.snapshot;
  assert(original);
  const cold = new MaterialResource(captureMaterialSnapshot({ ...original.material.snapshot }));
  const row = owner.prepareRow({
    ...original,
    entityKey: 1 << 20,
    material: cold,
    materials: [cold],
    materialOverrides: [cold],
  });
  const arena = f.scene.inputs.arena;
  const ranges = (arena as unknown as { ranges: StableRangeAllocator }).ranges;
  const nativeRelease = ranges.release.bind(ranges);
  const nativeReserve = arena.reserveDescriptor.bind(arena);
  let descriptorAddress: number | undefined;
  const observe = vi
    .spyOn(arena, 'reserveDescriptor')
    .mockImplementation((words, initialize, capture) =>
      nativeReserve(words, initialize, (value) => {
        descriptorAddress = value.address;
        capture?.(value);
      }),
    );
  const mapping = vi.spyOn(f.scene.inputs, 'reserveResource').mockImplementationOnce(() => {
    throw new Error('mapping constructor');
  });
  const failure = new Error('unknown descriptor rollback');
  const release = vi.spyOn(ranges, 'release').mockImplementation((start, count) => {
    nativeRelease(start, count);
    if (start === descriptorAddress) throw failure;
  });
  onTestFinished(async () => {
    observe.mockRestore();
    mapping.mockRestore();
    release.mockRestore();
    row.release();
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  let task: GpuSceneCapacityPreparation | undefined;
  const work = f.scene.prepareSourceRows(
    [row.row],
    (value) => {
      task = value;
    },
    () => row.isCurrent(),
    meshSources(f, original.assetHandle),
  );
  try {
    expect(() => {
      for (let step = 0; step < 100; step++) if (work.next().done) break;
    }).toThrow('capture and rollback failed');
    assert(task);
    const captured = task;
    expect(f.scene.live).toBe(false);
    const held = f.scene.sourceResourceAllocations(task).materials;
    expect(held).toHaveLength(1);
    expect(held[0]?.privateDescriptor?.address).toBe(descriptorAddress);
    expect(held[0]?.privateDescriptor?.isCurrent()).toBe(false);
    expect(task.inspect().privateDescriptorBytes).toBe(GPU_MATERIAL_DESCRIPTOR.words * 4);
    await f.internals.device.queue.onSubmittedWorkDone();
    expect(() => captured.retireStep()).toThrow();
    expect(task.inspect().phase).toBe('retiring');
    expect(() => captured.retireStep()).toThrow();
    expect(release.mock.calls.filter(([start]) => start === descriptorAddress)).toHaveLength(1);
  } finally {
    work.return(undefined as never);
  }
});

it('encodes cold defaults and overrides beside exact shared versions without changing active Inputs', async () => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  const owner = f.internals.sceneComposition?.entry?.projection;
  assert(owner);
  const original = owner.slotsSnapshot().at(0)?.snapshot;
  assert(original);
  const shared = original.material;
  const material = f.assets
    .create(Materials.standard({ baseColor: [1, 0, 1, 1], roughness: 0.123 }))
    .unwrap();
  const cold = new MaterialResource(
    captureMaterialSnapshot({
      ...shared.snapshot,
      materialHandle: material,
      baseColor: vec3.create(1, 0, 1),
      roughness: 0.123,
      paramSnapshot: Object.freeze({
        ...shared.snapshot.paramSnapshot,
        baseColor: [1, 0, 1, 1],
        roughness: 0.123,
      }),
    }),
  );
  const box = createBoxGeometry(2, 2, 2).unwrap();
  const part = box.submeshes[0];
  assert(part);
  const half = Math.floor(part.indexCount / 6) * 3;
  const asset = {
    ...box,
    materialSlots: [
      { slotName: 'Default', defaultMaterial: material },
      { slotName: 'Override', defaultMaterial: material },
    ],
    submeshes: [
      { ...part, indexOffset: 0, indexCount: half, materialSlot: 0 },
      { ...part, indexOffset: half, indexCount: part.indexCount - half, materialSlot: 1 },
    ],
  };
  const mesh = f.assets.create(asset).unwrap();
  const rows = [
    owner.prepareRow({ ...original, entityKey: 1 << 20 }),
    owner.prepareRow({
      ...original,
      entityKey: (1 << 20) + 1,
      assetHandle: mesh,
      material: cold,
      materials: [cold, shared],
      materialOverrides: [undefined, shared],
      materialBindingSources: ['mesh-default', 'renderer-override'],
    }),
  ];
  const guard = f.scene.inputs.captureGuard();
  const inputBytes = f.scene.inputs.arena.byteLength;
  const inputWords = Array.from({ length: inputBytes / 4 }, (_, index) =>
    f.scene.inputs.arena.readWord(index),
  );
  const observed = observeGpuInputBytes(f.internals.device);
  let task: GpuSceneCapacityPreparation | undefined;
  const work = f.scene.prepareSourceRows(
    rows.map((row) => row.row),
    (value) => {
      task = value;
    },
    () => rows.every((row) => row.isCurrent()),
    [...meshSources(f, original.assetHandle), ...meshSources(f, mesh)],
  );
  try {
    for (let step = 0; !work.next().done && step < 1000; step++) {
      /* exact Source preparation */
    }
    assert(task);
    assert(task.isCurrent());
    const resources = f.scene.sourceResourceAllocations(task);
    expect(resources.materials).toHaveLength(2);
    expect(resources.meshes).toHaveLength(2);
    const fixed = resources.materials.find((value) => value.resource === shared);
    const prepared = resources.materials.find((value) => value.resource === cold);
    const meshResource = resources.meshes.find((value) => value.geometry.handle === mesh);
    assert(
      fixed && prepared?.payload && prepared.privateDescriptor && meshResource?.privateDescriptor,
    );
    expect(fixed.privateDescriptor).toBeUndefined();
    expect(resources.meshes.filter((value) => value.privateDescriptor === undefined)).toHaveLength(
      1,
    );
    expect(f.scene.inputs.resourceIsCurrent(fixed.logicalSlot, fixed.descriptor)).toBe(true);
    expect(f.scene.inputs.resourceIsCurrent(prepared.logicalSlot, prepared.descriptor)).toBe(false);
    expect(prepared.privateDescriptor.readWord(GPU_MATERIAL_DESCRIPTOR.payload)).toBe(
      prepared.payload.start,
    );
    const bits = Uint32Array.of(meshResource.privateDescriptor.readWord(GPU_MESH_DESCRIPTOR.min));
    expect(new Float32Array(bits.buffer)[0]).toBe(-1);
    const tables = task.preparedTables();
    const primitive = tables?.find((value) => value.name === 'primitive');
    const materials = tables?.find((value) => value.name === 'material');
    assert(primitive && materials);
    const primitiveView = new DataView(primitive.bytes.buffer);
    const data = new DataView(materials.bytes.buffer);
    const addresses = f.scene.sourceRowAllocations(task);
    const row = addresses.find((value) => value.source.entityKey === rows[1]?.row.entityKey);
    assert(row);
    expect(row.snapshot.materialBindingSources).toEqual(['mesh-default', 'renderer-override']);
    expect(row.snapshot.materials).toEqual([cold, shared]);
    expect(
      primitiveView.getUint32(
        row.recordIndex * GPU_SCENE_LAYOUTS.primitive.stride +
          gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'materialIndex'),
        true,
      ),
    ).toBe(prepared.logicalSlot);
    expect(
      data.getFloat32(
        prepared.payload.start * 16 + gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.material, 'roughness'),
        true,
      ),
    ).toBeCloseTo(0.123);
    for (const table of tables ?? []) {
      assert(table.resource.kind === 'buffer');
      expect(observed.bytes.get(table.resource.buffer)).toEqual(table.bytes);
    }
    expect(f.scene.inputs.arena.byteLength).toBe(inputBytes);
    expect(
      Array.from({ length: inputBytes / 4 }, (_, index) => f.scene.inputs.arena.readWord(index)),
    ).toEqual(inputWords);
    expect(guard()).toBe(true);
    cold.adopt(captureMaterialSnapshot({ ...cold.snapshot, roughness: 0.8 }));
    expect(task.isCurrent()).toBe(false);
    expect((await f.draw()).presentation).toBe('ready');
  } finally {
    work.return(undefined as never);
    await f.internals.device.queue.onSubmittedWorkDone();
    if (task !== undefined) {
      for (let step = 0; !task.retireStep() && step < 1000; step++) {
        /* no frame */
      }
      expect(task.inspect().phase).toBe('retired');
    }
    for (const row of rows) row.release();
    observed.close();
  }
});

it('returns partially reserved GPU addresses on cancellation before native allocation without another frame', async () => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  const owner = f.internals.sceneComposition?.entry?.projection;
  assert(owner);
  const source = owner.slotsSnapshot().at(0)?.snapshot;
  assert(source);
  const rows = [
    owner.prepareRow({ ...source, entityKey: 1 << 20 }),
    owner.prepareRow({ ...source, entityKey: (1 << 20) + 1 }),
  ];
  let task: GpuSceneCapacityPreparation | undefined;
  const work = f.scene.prepareSourceRows(
    rows.map((row) => row.row),
    (value) => {
      task = value;
    },
    () => rows.every((row) => row.isCurrent()),
    meshSources(f, source.assetHandle),
  );
  try {
    for (let step = 0; step < 100; step++) {
      expect(work.next().done).toBe(false);
      if (task !== undefined && f.scene.sourceRowAllocations(task).length === 1) break;
    }
    assert(task);
    expect(f.scene.sourceRowAllocations(task)).toHaveLength(1);
    const address = f.scene.sourceRowAllocations(task)[0]?.recordIndex;
    expect(task.inspect().tables).toBe(0);
    work.return(undefined as never);
    await f.internals.device.queue.onSubmittedWorkDone();
    for (let step = 0; !task.retireStep() && step < 100; step++) {
      /* no frame */
    }
    expect(task.inspect().phase).toBe('retired');
    const first = rows[0];
    assert(first);
    let replacement: GpuSceneCapacityPreparation | undefined;
    const retry = f.scene.prepareSourceRows(
      [first.row],
      (value) => {
        replacement = value;
      },
      () => first.isCurrent(),
      meshSources(f, source.assetHandle),
    );
    try {
      for (let step = 0; !retry.next().done && step < 100; step++) {
        /* same owner, no frame */
      }
      assert(replacement);
      expect(f.scene.sourceRowAllocations(replacement)[0]?.recordIndex).toBe(address);
      expect(replacement.isCurrent()).toBe(true);
    } finally {
      retry.return(undefined as never);
      await f.internals.device.queue.onSubmittedWorkDone();
      if (replacement !== undefined) {
        for (let step = 0; !replacement.retireStep() && step < 100; step++) {
          /* no frame */
        }
        expect(replacement.inspect().phase).toBe('retired');
      }
    }
  } finally {
    work.return(undefined as never);
    await f.internals.device.queue.onSubmittedWorkDone();
    if (task !== undefined)
      for (let step = 0; !task.retireStep() && step < 100; step++) {
        /* no frame */
      }
    for (const row of rows) row.release();
  }
});

it('encodes actual private Source addresses without growth while old-world writes share their chunks', async () => {
  const f = await rendererInputHandoffFixture();
  onTestFinished(async () => {
    const closed = await f.close();
    if (!closed.ok) throw closed.error;
  });
  const entry = f.internals.sceneComposition?.entry;
  assert(entry);
  const original = entry.projection.slotsSnapshot().at(0);
  assert(original);
  const locals = new Float32Array(3 * 16);
  for (let ordinal = 0; ordinal < 3; ordinal++) {
    locals.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3 + ordinal * 2, 0, 0, 1], ordinal * 16);
  }
  const row = entry.projection.prepareRow({
    ...original.snapshot,
    entityKey: 1 << 20,
    instances: { transforms: locals, instanceCount: 3, cacheKey: 1, archVersion: 0, revision: 1 },
  });
  const identity = row.row;
  const active = [
    f.scene.primitiveBuffer,
    f.scene.instanceBuffer,
    f.scene.transformBuffer,
    f.scene.materialBuffer,
  ];
  const before = f.scene.inspect().tables;
  const extent = f.scene.rowAddressExtent;
  const revision = f.scene.allocationRevision;
  const observed = observeGpuInputBytes(f.internals.device);
  let task: GpuSceneCapacityPreparation | undefined;
  const work = f.scene.prepareSourceRows(
    [identity],
    (value) => {
      task = value;
    },
    () => row.isCurrent(),
    meshSources(f, original.snapshot.assetHandle),
  );
  try {
    let result = work.next();
    for (let step = 0; !result.done && step < 1000; step++) {
      f.world
        .set(original.entityKey as EntityHandle, Transform, { pos: [step / 100, 0, 0] })
        .unwrap();
      expect((await f.draw()).presentation).toBe('ready');
      result = work.next();
    }
    assert(result.done);
    assert(task);
    const addresses = f.scene.sourceRowAllocations(task);
    const encoded = addresses[0];
    assert(encoded);
    expect(addresses).toHaveLength(1);
    expect(encoded.source).toBe(identity);
    expect(f.scene.primitiveIndexForSlot(identity.slot)).toBeUndefined();
    expect(f.scene.rowAddressExtent).toBe(extent);
    expect(f.scene.allocationRevision).toBe(revision);
    expect(f.scene.inspect().tables).toEqual(before);
    expect([
      f.scene.primitiveBuffer,
      f.scene.instanceBuffer,
      f.scene.transformBuffer,
      f.scene.materialBuffer,
    ]).toEqual(active);
    const tables = task.preparedTables();
    assert(tables);
    expect(tables).toHaveLength(4);
    for (const table of tables) {
      assert(table.resource.kind === 'buffer');
      expect(active).not.toContain(table.resource.buffer);
      expect(table.bytes).toEqual(observed.bytes.get(table.resource.buffer));
    }
    const transforms = tables.find((value) => value.name === 'transform');
    const instances = tables.find((value) => value.name === 'instance');
    assert(transforms && instances);
    const transformView = new DataView(transforms.bytes.buffer);
    const instanceView = new DataView(instances.bytes.buffer);
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      const at = (encoded.instanceStart + ordinal) * INSTANCE.stride;
      const index = encoded.instanceTransformStart + ordinal;
      expect(
        instanceView.getUint32(at + gpuSceneFieldOffset(INSTANCE, 'primitiveIndex'), true),
      ).toBe(encoded.recordIndex);
      expect(
        instanceView.getUint32(at + gpuSceneFieldOffset(INSTANCE, 'transformIndex'), true),
      ).toBe(index);
      expect(transformView.getFloat32(index * TRANSFORM.stride + 12 * 4, true)).toBe(
        3 + ordinal * 2,
      );
      expect(
        transformView.getUint32(
          index * TRANSFORM.stride + gpuSceneFieldOffset(TRANSFORM, 'previousIndex'),
          true,
        ),
      ).toBe(index);
    }
    const target = f.scene.prepareCapacityBindingTarget(task).unwrap();
    expect(f.scene.publishCapacityTarget(target).ok).toBe(false);
    expect(task.inspect().privateWriteBytes).toBe(
      4 * TRANSFORM.stride + 3 * INSTANCE.stride + GPU_SCENE_LAYOUTS.primitive.stride,
    );
    expect(entry.projection.slot(identity.entityKey)).toBeUndefined();
  } finally {
    work.return(undefined as never);
    await f.internals.device.queue.onSubmittedWorkDone();
    if (task !== undefined) {
      for (let step = 0; !task.retireStep() && step < 1000; step++) {
        /* no frame */
      }
      expect(task.inspect().phase).toBe('retired');
      expect(f.scene.sourceRowAllocations(task)).toHaveLength(0);
    }
    row.release();
    observed.close();
  }
});
