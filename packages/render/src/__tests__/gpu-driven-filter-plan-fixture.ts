import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { mat4, vec3 } from '@forgeax/engine-math';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import { expect, onTestFinished } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { prepareBatchExecution } from '../gpu-driven/batch-execution';
import { batchVisibleSpan } from '../gpu-driven/batch-layout';
import { BatchTopology, type SubmissionPlan } from '../gpu-driven/batch-topology';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { assemblePreparedPlan, prepareBatchRows } from '../gpu-driven/production-raster-prepare';
import { GpuBuffer } from '../gpu-resource';
import { GPU_BUFFER_USAGE_INDEX, GPU_BUFFER_USAGE_VERTEX } from '../gpu-usage';
import { MaterialResource } from '../material-resource';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { preparedPbrSnapshot } from './gpu-driven-production-fixture';

export function createFilterPlanFixture(
  options: { sharedGeometry?: boolean; instances?: number } = {},
) {
  const instanceCount = options.instances ?? 2;
  const shared = new MaterialResource({
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 1,
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
  });
  const scene = new RenderScene();
  scene.apply(
    [0, 1, 2].map((index) => {
      const world = mat4.identity(mat4.create());
      const snapshot: RenderableSnapshot = preparedPbrSnapshot({
        worldId: 0,
        entityKey: index + 1,
        assetHandle: options.sharedGeometry ? 3 : 3 + index,
        transform: { world },
        localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
        material: shared,
        materials: [shared],
        materialBindingSources: ['engine-default'],
        instances: {
          transforms: new Float32Array(
            Array.from({ length: instanceCount }, () => [...world]).flat(),
          ),
          instanceCount,
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
      return {
        kind: 'update' as const,
        worldId: 0,
        entityKey: index + 1,
        snapshot: { ...snapshot, material: shared, materials: [shared] },
      };
    }),
  );
  const slots = scene.slotsSnapshot();
  const topology = new BatchTopology();
  topology.rebuild(slots);
  const source = topology.query(topology.sourcePlan(), undefined);
  expect(source.batches).toHaveLength(options.sharedGeometry ? 1 : 3);
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
  const prepare = (plan: SubmissionPlan = source) => {
    const rows = plan.batches.map((source) => {
      const binding = defined(source.binding);
      const execution = prepareBatchExecution(
        binding.geometry,
        binding.material.snapshot,
        { kind: 'forward', shaderId: artifact.material },
        () => artifact,
      ).unwrap();
      const batch =
        execution.route === 'gpu' ? { ...source, prepared: execution.prepared } : source;
      return prepareBatchRows(batch, { mesh, worldKeys: undefined, execution });
    });
    return assemblePreparedPlan(
      { ...plan, batches: rows.map((row) => row.source) },
      rows,
      undefined,
    );
  };
  const bindings = new Map(
    slots.map((slot) => [`${slot.worldId}:${slot.entityKey}`, slot.slot === 1 ? 'B' : 'A']),
  );
  return { source, slots, prepare, bindings, mesh, material: shared };
}

export function freshFilteredPlan(
  prepared: import('../gpu-driven/production-raster-prepare').PreparedProductionPlan,
  bindings?: ReadonlyMap<string, string>,
) {
  return new FilteredPlanContributionOwner().update(prepared, bindings);
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
    const batchContent = (batch: import('../gpu-driven/batch-topology').GpuDrivenBatch) => {
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
  expect(value.materialBatches.map((row) => value.batches.indexOf(row))).toEqual(
    expected.materialBatches.map((row) => expected.batches.indexOf(row)),
  );
};
