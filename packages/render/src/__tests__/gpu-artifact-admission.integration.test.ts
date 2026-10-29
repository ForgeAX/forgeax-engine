import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import { RenderScene } from '../scene/render-scene';
import {
  admitGpuFixture,
  mesh,
  preparedPbrSnapshot,
  snapshot,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';

async function fixture() {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const inputs = standardPbrInputs(device, shader, layout);
  const base = inputs.materialArtifact;
  if (base?.receipt === undefined) throw new Error('expected receipt');
  const receipt = base.receipt;
  const artifacts = [0, 1].map((index) => ({
    ...base,
    receipt: { ...receipt, receiptIdentity: `admission-${index}` },
  }));
  const keyOf = (index: number) => `admission-${index}`;
  const keys = artifacts.map((_, index) => keyOf(index));
  const materialArtifacts = new Map(
    artifacts.map((artifact, index) => [keyOf(index), artifact] as const),
  );
  const projection = new RenderScene();
  const rows = artifacts.map((_, index) => {
    const row = preparedPbrSnapshot(snapshot(index + 1, index + 10));
    const material = new MaterialResource({
      ...row.material.snapshot,
      materialSceneIndexProgramKeys: {
        forward: { pass: 'forward', specializationKey: keyOf(index) },
      },
    });
    return { ...row, material, materials: [material] };
  });
  const available = GpuScene.create(device, 4).unwrap();
  if (available.status !== 'available') throw new Error('expected GPU Scene');
  const scene = available.scene;
  scene.sync(projection.apply(rows.map(updateSnapshot))).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const plan = topology.query(topology.sourcePlan(), undefined);
  expect(plan.batches).toHaveLength(2);
  const shared = mesh(device);
  const meshes = new Map(projection.slotsSnapshot().map(({ slot }) => [slot, shared]));
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  return {
    artifacts,
    keys,
    materialArtifacts,
    meshes,
    scene,
    production,
    replaceFirstMesh() {
      meshes.set(plan.batches.at(0)?.candidates.at(0)?.primitiveIndex ?? -1, mesh(device));
    },
    prepare() {
      const result = production.prepare(
        admitGpuFixture({
          ...inputs,
          materialArtifacts,
          scene: { scene, plan, slots: projection.slotsSnapshot(), slotAt: projection.slotAt },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: meshes,

          viewBindGroupLayout: layout,
        }),
      );
      if (result.ok) result.value?._commitResourceReplacement();
      return result;
    },
    close() {
      production.dispose();
      scene.dispose();
    },
  };
}

it('checks each retained batch artifact once while keeping missing-receipt admission live', async () => {
  const f = await fixture();
  const lookup = vi.spyOn(f.materialArtifacts, 'get');
  try {
    expect(f.prepare().unwrap()).toBeDefined();
    lookup.mockClear();
    expect(f.prepare().unwrap()).toBeDefined();
    expect(lookup.mock.calls.map(([key]) => key)).toEqual(f.keys);
    f.materialArtifacts.delete(f.keys[1] ?? '');
    const missing = f.artifacts[1];
    if (missing === undefined) throw new Error('expected second artifact');
    expect(() => f.prepare()).toThrow(
      expect.objectContaining({
        code: 'missing-material-receipt',
        detail: expect.objectContaining({ owner: 'material', reason: 'material-receipt-missing' }),
      }),
    );
  } finally {
    lookup.mockRestore();
    f.close();
  }
});

it('preserves mesh content invalidation across missing-artifact failure and retry', async () => {
  const f = await fixture();
  try {
    expect(f.prepare().unwrap()).toBeDefined();
    const revision = f.scene.contentRevision;
    const allocationCount = f.production.inspect().resourceAllocation?.successfulAllocationCount;
    expect(allocationCount).toBeDefined();
    f.replaceFirstMesh();
    f.materialArtifacts.delete(f.keys[1] ?? '');
    expect(() => f.prepare()).toThrow(
      expect.objectContaining({
        code: 'missing-material-receipt',
        detail: expect.objectContaining({ owner: 'material' }),
      }),
    );
    expect(f.production.inspect().resourceAllocation?.successfulAllocationCount).toBe(
      allocationCount,
    );
    const restored = f.artifacts[1];
    if (restored === undefined) throw new Error('expected second artifact');
    f.materialArtifacts.set(f.keys[1] ?? '', restored);
    const recovered = f.prepare().unwrap();
    expect(recovered?.materialBindings).toHaveLength(2);
    expect(f.production.inspect().preparedBatchBuilds).toBe(1);
    expect(f.scene.contentRevision).toBe(revision);
    const stableRevision = f.scene.contentRevision;
    const stable = f.prepare().unwrap();
    expect(stable?.topologySignature()).toBe(recovered?.topologySignature());
    expect(f.production.inspect().preparedBatchBuilds).toBe(0);
    expect(f.scene.contentRevision).toBe(stableRevision);
  } finally {
    f.close();
  }
});
