import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { mat4, vec3 } from '@forgeax/engine-math';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import { expect, onTestFinished } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import {
  BatchTopology,
  batchVisibleSpan,
  type GpuDrivenCandidate,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import { materialBindingKey } from '../gpu-driven/material-bindings';
import { assemblePreparedPlan, prepareBatchRows } from '../gpu-driven/production-raster-prepare';
import { GpuBuffer } from '../gpu-resource';
import { GPU_BUFFER_USAGE_INDEX, GPU_BUFFER_USAGE_VERTEX } from '../gpu-usage';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { preparedPbrSnapshot } from './gpu-driven-production-fixture';

export function createFilterPlanFixture() {
  const scene = new RenderScene();
  scene.apply(
    [0, 1, 2].map((index) => {
      const world = mat4.identity(mat4.create());
      const material = {
        baseColor: vec3.create(1, 1, 1),
        metallic: 0,
        roughness: 1,
        materialHandle: 100 + index,
      };
      const snapshot: RenderableSnapshot = preparedPbrSnapshot({
        worldId: 0,
        entityKey: index + 1,
        assetHandle: 3,
        transform: { world },
        localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
        material,
        materials: [material],
        materialBindingSources: ['engine-default'],
        instances: {
          transforms: new Float32Array([...world, ...world]),
          instanceCount: 2,
          cacheKey: index + 1,
          archVersion: 1,
        },
        lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
        gpuDrivenDraws: [
          {
            kind: 'indexed',
            first: 0,
            count: 3,
            baseVertex: 0,
            materialSlot: 0,
            topology: 'triangle-list',
            pipelineClass: 'standard-pbr',
            materialResourceClass: 'standard-pbr-resources',
          },
        ],
      });
      return { kind: 'update' as const, worldId: 0, entityKey: index + 1, snapshot };
    }),
  );
  const slots = scene.slotsSnapshot();
  const topology = new BatchTopology();
  topology.rebuild(slots);
  const root = defined(topology.plan().batches[0]);
  expect(topology.plan().batches).toHaveLength(1);
  const candidate = (primitiveIndex: number, instanceOrdinal: number): GpuDrivenCandidate => ({
    primitiveIndex,
    instanceOrdinal,
    generation: defined(slots[primitiveIndex]).generation,
    drawItemIndex: 0,
  });
  const partitions = [
    [candidate(2, 0), candidate(1, 0)],
    [candidate(0, 0), candidate(2, 1)],
    [candidate(1, 1), candidate(0, 1)],
  ];
  // Distinct authored LOD ranges split source batches; residency supplies the
  // same canonical physical range, so filtering must merge across partitions.
  const source: SubmissionPlan = {
    ...topology.plan(),
    batches: partitions.map((candidates, batchId) => ({
      ...root,
      key: { ...root.key },
      batchId,
      candidates,
      lod: {
        coverages: [1, 0.5],
        ranges: [{ first: 100 * (batchId + 1), count: 3, baseVertex: 0 }],
      },
    })),
  };
  const receipt = createStandardPbrArtifactReceipt();
  const artifact = {
    material: 'forgeax::default-standard-pbr',
    pass: 'forward',
    program: createMaterialShaderProgram('synthetic'),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    vertexInputs: receipt.vertexInputs as unknown as readonly Readonly<Record<string, unknown>>[],
    receipt,
  };
  // Physical raster identities belong to real resident buffers even when
  // this fixture only exercises the post-residency projection boundary.
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (bookkeeper, owner) => new RhiNullCommandEncoder(bookkeeper, owner),
  );
  const vertexBuffer = new GpuBuffer(
    device,
    device.createBuffer({ size: 144, usage: GPU_BUFFER_USAGE_VERTEX }).unwrap(),
  );
  const indexBuffer = new GpuBuffer(
    device,
    device.createBuffer({ size: 12, usage: GPU_BUFFER_USAGE_INDEX }).unwrap(),
  );
  onTestFinished(() => {
    vertexBuffer.destroy().unwrap();
    indexBuffer.destroy().unwrap();
  });
  const mesh: MeshGpuHandles = {
    contentEpoch: 0,
    vboBytes: 144,
    iboBytes: 12,
    indexCount: 6,
    indexFormat: 'uint16',
    layoutProjection: deriveVertexLayoutProjection({
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
    }),
    uvSetCount: 1,
    vertexCount: 3,
    topology: 'triangle-list',
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, materialSlot: 0, topology: 'triangle-list' },
    ],
    vertexBuffer,
    indexBuffer,
    indexed: true,
    lodRanges: [[{ first: 0, count: 3, baseVertex: 0 }], [{ first: 3, count: 3, baseVertex: 0 }]],
  };
  const inputs = {
    slotAt: scene.slotAt,
    meshBySlot: new Map(slots.map((slot) => [slot.slot, mesh])),
    worldKeys: undefined,
    materialArtifact: artifact,
    skinArtifact: undefined,
    materialArtifacts: undefined,
  };
  const prepare = (plan = source) =>
    assemblePreparedPlan(
      plan,
      plan.batches.map((batch) => prepareBatchRows(batch, inputs)),
      slots,
      undefined,
    );
  const bindings = new Map(
    slots.map((slot) => [
      materialBindingKey(slot.snapshot, slot.snapshot.material.materialHandle ?? -1),
      slot.slot === 1 ? 'B' : 'A',
    ]),
  );
  return { source, slots, prepare, bindings };
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Missing filter plan fixture value');
  return value;
}

export const expectFilteredPlanContent = (
  value: import('../gpu-driven/production-raster-prepare').FilteredProductionPlan,
  expected: import('../gpu-driven/production-raster-prepare').FilteredProductionPlan,
) => {
  // Admission/content must match the dense reference; physical allocation is
  // deliberately retained independently and checked below for overlap/bounds.
  const content = (
    plan: import('../gpu-driven/production-raster-prepare').FilteredProductionPlan,
  ) => {
    const batchContent = (batch: (typeof plan.plan.batches)[number]) => {
      const {
        batchId: _id,
        generation: _generation,
        visibleBase: _base,
        visibleAllocationCapacity: _reserved,
        indirectOffset: _indirect,
        ...facts
      } = batch;
      return facts;
    };
    const { visibleCapacity: _capacity, ...planFacts } = plan.plan;
    return {
      ...plan,
      plan: { ...planFacts, batches: plan.plan.batches.map(batchContent) },
      batches: plan.batches.map((row) => ({ ...row, batch: batchContent(row.batch) })),
      materialBatches: plan.materialBatches.map((row) => ({
        ...row,
        batch: batchContent(row.batch),
      })),
    };
  };
  expect(content(value)).toEqual(content(expected));
  const windows = [...value.plan.batches].sort((a, b) => a.visibleBase - b.visibleBase);
  windows.forEach((batch, index) => {
    const end = batch.visibleBase + batchVisibleSpan(batch);
    expect(end).toBeLessThanOrEqual(value.plan.visibleCapacity);
    const next = windows[index + 1];
    if (next !== undefined) expect(end).toBeLessThanOrEqual(next.visibleBase);
  });
  expect(
    value.batches.map((row) => [row.mesh, row.artifact, row.primitiveSlot, row.slotGeneration]),
  ).toEqual(
    expected.batches.map((row) => [row.mesh, row.artifact, row.primitiveSlot, row.slotGeneration]),
  );
};
