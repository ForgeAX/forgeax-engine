import { createBoxGeometry } from '@forgeax/engine-geometry';
import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { buildGpuDrivenDraws } from '../extract/gpu-driven';
import { MemberCandidates } from '../gpu-driven/batch-members';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { GPU_MEMBER_RECORD_WORDS } from '../gpu-scene-inputs';
import { MaterialResource } from '../material-resource';
import type { RenderableSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';
import { MeshFrame } from '../scene/mesh-frame';
import { captureMaterialOverrides } from '../scene/mesh-materials';
import { RenderScene } from '../scene/render-scene';
import { observeCandidateReads } from './gpu-driven-candidate-read-observer';
import { updateGpuView } from './helpers/gpu-input-read-domain';

function setup(count = 10_000) {
  const a = new MaterialResource({
    passes: [],
    baseColor: vec3.create(1, 0, 0),
    metallic: 0,
    roughness: 1,
  });
  const b = new MaterialResource({
    passes: [],
    baseColor: vec3.create(0, 1, 0),
    metallic: 0,
    roughness: 1,
  });
  const c = new MaterialResource({
    passes: [],
    baseColor: vec3.create(0, 0, 1),
    metallic: 0,
    roughness: 1,
  });
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const first: RenderableSnapshot = {
    worldId: 0,
    entityKey: 0,
    assetHandle: 7,
    material: a,
    materials: [a],
    materialBindingSources: ['mesh-default'],
    materialOverrides: captureMaterialOverrides([undefined, c]),
    transform: { world: mat4.identity(mat4.create()) },
    localAabb: Float32Array.of(-1, -1, -1, 1, 1, 1),
    gpuDrivenDraws: buildGpuDrivenDraws({
      mesh,
      materials: [a.snapshot],
      fallbackMaterial: a.snapshot,
      deformation: 'rigid',
    }),
  };
  const scene = new RenderScene();
  const delta = scene.apply(
    Array.from({ length: count }, (_, entityKey) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey,
      snapshot: { ...first, entityKey },
    })),
  );
  const topology = new BatchTopology();
  topology.apply(delta);
  const initial = new MeshFrame().with(0, 7, mesh, [a]);
  const section = mesh.submeshes[0];
  assert(section);
  const changed: MeshAsset = {
    ...mesh,
    submeshes: [
      { ...section, indexCount: 18 },
      { ...section, indexOffset: 18, indexCount: 18, materialSlot: 1 },
    ],
    materialSlots: [{ slotName: 'one' }, { slotName: 'two' }],
    lods: [{ mesh: 12 as never, screenCoverage: 0.2 }],
    lodHysteresis: 0.12,
  };
  return { a, b, c, mesh, changed, scene, delta, topology, initial };
}

it('expands changed submeshes, topology and LOD from one fixed root without touching membership', () => {
  const f = setup();
  const before = f.topology.query(f.topology.sourcePlan(), f.initial),
    membership = f.topology.inspect();
  const old = before.batches.at(0);
  assert(old);
  const edited = f.initial.with(0, 7, f.changed, [f.b, f.b]);
  const after = f.topology.query(f.topology.sourcePlan(), edited);
  expect(after.batches).toHaveLength(2);
  for (const batch of after.batches) {
    expect(batch.candidates).toBe(old.candidates);
    expect(batch.members).toBe(old.members);
    expect(batch.lod).toEqual({ coverages: [1, 0.2], hysteresis: 0.12 });
  }
  expect(after.batches.map((batch) => batch.binding?.material)).toEqual([f.b, f.c]);
  expect(after.batches.map((batch) => [batch.key.first, batch.key.count])).toEqual([
    [0, 18],
    [18, 18],
  ]);
  expect(f.topology.inspect()).toMatchObject({
    candidateAdds: membership.candidateAdds,
    candidateRemoves: membership.candidateRemoves,
    membershipChecks: membership.membershipChecks,
  });
  const changedSection = f.changed.submeshes[0];
  assert(changedSection);
  const { indices: _indices, ...nonIndexed } = f.mesh;
  const points = f.initial.with(
    0,
    7,
    {
      ...nonIndexed,
      submeshes: [{ ...changedSection, topology: 'point-list', vertexCount: 4, indexCount: 0 }],
    },
    [f.b],
  );
  const point = f.topology.query(f.topology.sourcePlan(), points).batches.at(0);
  assert(point);
  expect(point.key).toMatchObject({ drawKind: 'non-indexed', topology: 'point-list', count: 4 });
  expect(point.binding?.geometry.receipt.indexed).toBe(false);
  expect(point.candidates).toBe(old.candidates);
  expect(old.key).toMatchObject({ drawKind: 'indexed', topology: 'triangle-list', count: 36 });
  expect(old.binding?.material).toBe(f.a);
  const restored = f.topology.query(f.topology.sourcePlan(), f.initial);
  expect(restored.batches.at(0)?.candidates).toBe(old.candidates);
  expect(restored.batches.at(0)?.binding).toBe(old.binding);
});

it('adds a GPU execution without reading, copying, reallocating or uploading shared candidate rows', async () => {
  const f = setup();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const admitted = GpuScene.create(device, 10_000).unwrap();
  assert(admitted.status === 'available');
  const gpu = admitted.scene;
  gpu.sync(f.delta).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'null fixture' })).unwrap();
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const first = f.topology.query(f.topology.sourcePlan(), f.initial);
  const original = first.batches.at(0)?.candidates;
  assert(original);
  let reads = 0;
  const stopObserving = observeCandidateReads([original], () => {
    reads++;
  });
  const at = vi.spyOn(MemberCandidates.prototype, 'at');
  const iterator = vi.spyOn(MemberCandidates.prototype, Symbol.iterator);
  const expansions = () => at.mock.calls.length + iterator.mock.calls.length;
  try {
    updateGpuView(view, first, gpu, planes).unwrap();
    expect(reads).toBeGreaterThan(0);
    const recordBytes = 10_000 * GPU_MEMBER_RECORD_WORDS * 4;
    expect(view.inspect().sharedInputUploadBytes).toBeGreaterThanOrEqual(recordBytes);
    expect(view.inspect().sharedInputUploadBytes).toBeLessThanOrEqual(2 * recordBytes);
    expect(expansions()).toBe(0);
    const capacity = view.inspect().candidateCapacity;
    reads = 0;
    updateGpuView(
      view,
      f.topology.query(f.topology.sourcePlan(), f.initial.with(0, 7, f.changed, [f.b, f.b])),
      gpu,
      planes,
    ).unwrap();
    expect(reads).toBeLessThanOrEqual(4); // O(1) root lookup per actual task.
    expect(expansions()).toBe(0);
    expect(view.inspect().sharedInputUploadBytes).toBe(0);
    expect(view.inspect().candidateCapacity).toBe(capacity);
    expect(view.inspect().batchUploadBytes).toBeGreaterThan(0);
    view._commitResourceReplacement();
    await device.queue.onSubmittedWorkDone();
    reads = 0;
    updateGpuView(view, first, gpu, planes).unwrap();
    expect(reads).toBeLessThanOrEqual(4); // O(1) root lookup per actual task.
    expect(expansions()).toBe(0);
    expect(view.inspect().sharedInputUploadBytes).toBe(0);
  } finally {
    stopObserving();
    at.mockRestore();
    iterator.mockRestore();
    view.dispose();
    gpu.dispose();
  }
});

it('resides switched Mesh defaults once without upserting consumers and retains captured old values', async () => {
  const f = setup();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const admitted = GpuScene.create(device, 10_000).unwrap();
  assert(admitted.status === 'available');
  const gpu = admitted.scene;
  const initial = {
    ...f.delta,
    meshes: f.initial,
    materials: new MaterialFrame(undefined).with(f.a),
  };
  gpu.sync(initial).unwrap();
  const before = gpu.captureResources().unwrap();
  const oldAddress = before.indexForResource(f.a, f.a.snapshot);
  assert(oldAddress !== undefined);
  const oldGeometry = before.indexForGeometry(0, 7, f.initial.get(0, 7));
  assert(oldGeometry !== undefined);
  const edited = f.initial.with(0, 7, f.changed, [f.b, f.b]);
  const empty = f.scene.apply([]);
  const visited = gpu.inspect().instanceRowsVisited;
  const materials = initial.materials.without(f.a).with(f.b);
  const changed = gpu.sync({ ...empty, meshes: edited, materials }).unwrap();
  expect(changed.bytes).toBeGreaterThan(0);
  expect(gpu.inspect().instanceRowsVisited).toBe(visited);
  const after = gpu.captureResources().unwrap();
  const newAddress = after.indexForResource(f.b, f.b.snapshot);
  assert(newAddress !== undefined);
  expect(newAddress).not.toBe(oldAddress);
  expect(before.indexForResource(f.a, f.a.snapshot)).toBe(oldAddress);
  expect(before.indexForGeometry(0, 7, f.initial.get(0, 7))).toBe(oldGeometry);
  const bounds = edited.with(0, 7, { ...f.changed, aabb: Float32Array.of(-2, -2, -2, 2, 2, 2) }, [
    f.b,
    f.b,
  ]);
  const boundsOnly = gpu.sync({ ...empty, meshes: bounds, materials }).unwrap();
  // Only the one fixed geometry descriptor changes; the default B was already initialized.
  expect(boundsOnly.bytes).toBeLessThanOrEqual(64);
  expect(gpu.materialIndexForResource(f.b)).toBe(newAddress);
  before.release();
  after.release();
  gpu
    .sync({
      ...f.scene.apply(
        f.scene
          .slotsSnapshot()
          .map((slot) => ({ kind: 'remove' as const, worldId: 0, entityKey: slot.entityKey })),
      ),
      materials: new MaterialFrame(undefined),
    })
    .unwrap();
  expect(gpu.materialIndexForResource(f.b)).toBeUndefined();
  gpu.dispose();
});
