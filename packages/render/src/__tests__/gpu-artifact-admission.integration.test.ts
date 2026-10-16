import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuScene } from '../gpu-scene';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import { RenderScene } from '../scene/render-scene';
import {
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
  const base = inputs.standardPbrArtifact;
  if (base?.receipt === undefined) throw new Error('expected receipt');
  const receipt = base.receipt;
  const artifacts = [0, 1].map((index) => ({
    ...base,
    receipt: { ...receipt, receiptIdentity: `admission-${index}` },
  }));
  const artifactKey = (artifact: (typeof artifacts)[number]) =>
    gpuDrivenMaterialArtifactKey({
      material: artifact.material,
      deformation: 'rigid',
      receiptIdentity: artifact.receipt.receiptIdentity,
      receiptGeneration: artifact.receipt.generation,
    });
  const materialArtifacts = new Map(
    artifacts.map((artifact) => [artifactKey(artifact), artifact] as const),
  );
  const keys = [...materialArtifacts.keys()];
  const projection = new RenderScene();
  const rows = artifacts.map((artifact, index) => {
    const row = preparedPbrSnapshot(snapshot(index + 1, index + 10));
    return {
      ...row,
      gpuDrivenDraws: (row.gpuDrivenDraws ?? []).map((draw) => {
        if (draw.prepared === undefined) throw new Error('expected prepared draw');
        return {
          ...draw,
          prepared: { ...draw.prepared, receiptIdentity: artifact.receipt.receiptIdentity },
        };
      }),
    };
  });
  const available = GpuScene.create(device, 4).unwrap();
  if (available.status !== 'available') throw new Error('expected GPU Scene');
  const scene = available.scene;
  scene.sync(projection.apply(rows.map(updateSnapshot))).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const plan = topology.plan();
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
      meshes.set(plan.batches[0]?.candidates[0]?.primitiveIndex ?? -1, mesh(device));
    },
    prepare(meshResidencyEpoch = 1) {
      return production.prepare({
        ...inputs,
        materialArtifacts,
        scene: { scene, plan, slots: projection.slotsSnapshot(), slotAt: projection.slotAt },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: meshes,
        meshResidencyEpoch,
        viewBindGroupLayout: layout,
        shadowCasterMembership: [],
      });
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
    expect(f.prepare()).toMatchObject({
      ok: false,
      error: {
        code: 'missing-material-receipt',
        expected: 'a producer-owned material program receipt is present',
        detail: {
          owner: 'material',
          reason: 'material-receipt-missing',
          expected: `published artifact for ${missing.material} (${missing.receipt.receiptIdentity}@${missing.receipt.generation})`,
        },
      },
    });
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
    expect(f.prepare(2)).toMatchObject({
      ok: false,
      error: { code: 'missing-material-receipt', detail: { owner: 'material' } },
    });
    expect(f.production.inspect().resourceAllocation?.successfulAllocationCount).toBe(
      allocationCount,
    );
    const restored = f.artifacts[1];
    if (restored === undefined) throw new Error('expected second artifact');
    f.materialArtifacts.set(f.keys[1] ?? '', restored);
    const recovered = f.prepare(2).unwrap();
    expect(recovered?.drawKeys?.size).toBe(2);
    expect(f.scene.changedSlotsSince(revision)).toEqual([0]);
    const stableRevision = f.scene.contentRevision;
    const stable = f.prepare(2).unwrap();
    expect(stable?.topologySignature).toBe(recovered?.topologySignature);
    expect(f.production.inspect().preparedBatchBuilds).toBe(0);
    expect(f.scene.contentRevision).toBe(stableRevision);
  } finally {
    f.close();
  }
});
