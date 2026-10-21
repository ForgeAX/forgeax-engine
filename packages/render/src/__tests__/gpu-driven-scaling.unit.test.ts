import { mat4, vec3 } from '@forgeax/engine-math';
import { beforeAll, describe, expect, it } from 'vitest';
import { batchLodLevelCount, batchVisibleSpan } from '../gpu-driven/batch-layout';
import { BatchTopology, projectedHeightForCandidate } from '../gpu-driven/batch-topology';
import { deriveGpuDrivenViewBufferCapacities } from '../gpu-driven/view-gpu';
import { MaterialResource } from '../material-resource';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { RenderScene } from '../scene/render-scene';
import { projectedHeight as measureProjectedHeight } from '../scene/visibility/lod-selector';

const ENTITY_COUNT = 100_000;
const material = new MaterialResource({
  baseColor: new Float32Array([0.25, 0.5, 0.75]),
  metallic: 0,
  roughness: 1,
  materialShaderId: 'forgeax::default-unlit',
} as MaterialSnapshot);

function snapshot(entityKey: number): RenderableSnapshot {
  return {
    assetHandle: 1,
    transform: { world: new Float32Array(mat4.identity(mat4.create())) },
    localAabb: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 36,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'forgeax::default-unlit|triangle-list|null',
        materialResourceClass: '{"textures":[],"samplers":[],"video":[]}',
        geometry: {
          receipt: { identity: 'cube', vertexInputs: [], topology: 'triangle-list', indexed: true },
          draw: { kind: 'indexed', first: 0, count: 36, baseVertex: 0, topology: 'triangle-list' },
          deformation: 'rigid',
        },
      },
    ],
  };
}

describe('GPU-driven scaling contract', () => {
  let projection: RenderScene;
  let topology: BatchTopology;
  let materialized: FrameList<RenderableSnapshot>;
  let stablePlan: ReturnType<BatchTopology['query']>;
  let stableMaterializationReused = false;
  let stablePlanReused = false;
  let delta: ReturnType<RenderScene['apply']>;
  let topologyChanged = true;

  beforeAll(() => {
    projection = new RenderScene();
    projection.reset(Array.from({ length: ENTITY_COUNT }, (_, index) => snapshot(index)));
    materialized = projection.materialize();
    topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    stablePlan = topology.query(topology.sourcePlan(), undefined);
    stableMaterializationReused = projection.materialize() === materialized;
    stablePlanReused = topology.query(topology.sourcePlan(), undefined) === stablePlan;

    const moved = mat4.identity(mat4.create());
    moved[12] = 3;
    delta = projection.apply([{ kind: 'update', worldId: 0, entityKey: 50_000, world: moved }]);
    topologyChanged = topology.apply(delta);
  });

  it('projects 100k candidates into one reserved batch without increasing GPU buffer capacity', () => {
    expect(stablePlan).toMatchObject({
      candidateCount: ENTITY_COUNT,
      visibleCapacity: 100_032,
    });
    expect(stablePlan.batches.length).toBe(1);
    expect(stablePlan.batches.at(0)?.visibleCapacity).toBe(ENTITY_COUNT);
    expect(deriveGpuDrivenViewBufferCapacities(stablePlan).visible).toBe(131_072);
  });

  it('keeps 100k LOD candidates dense in one shared-chain batch with per-level segments', () => {
    const lodProjection = new RenderScene();
    lodProjection.reset(
      Array.from({ length: ENTITY_COUNT }, (_, index) => ({
        ...snapshot(index),
        lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
      })),
    );
    const lodTopology = new BatchTopology();
    lodTopology.rebuild(lodProjection.slotsSnapshot());
    const plan = lodTopology.query(lodTopology.sourcePlan(), undefined);
    expect(plan.candidateCount).toBe(ENTITY_COUNT);
    expect(plan.batches).toHaveLength(1);
    const batch = plan.batches.at(0);
    if (batch === undefined) throw new Error('missing LOD batch');
    expect(batchLodLevelCount(batch)).toBe(2);
    expect(plan.visibleCapacity).toBe(batchVisibleSpan(batch));
    // Sharing the chain replaces 100k singleton batches (8M visible slots)
    // with two level segments of one aligned capacity.
    expect(deriveGpuDrivenViewBufferCapacities(plan)).toEqual({
      candidate: 131_072,
      visible: 262_144,
      batch: 1,
      indirect: 2,
    });
  });

  it('reuses materialization and topology identities while static', () => {
    expect(stableMaterializationReused).toBe(true);
    expect(stablePlanReused).toBe(true);
  });

  it('patches one transform without rebuilding topology', () => {
    expect(delta).toMatchObject({ updated: 1, created: 0, removed: 0 });
    expect(topologyChanged).toBe(false);
    expect(topology.query(topology.sourcePlan(), undefined)).toBe(stablePlan);
    expect(topology.inspect()).toMatchObject({ patches: 0, candidateCount: ENTITY_COUNT });
  });

  it('projects the candidate AABB through world scale and rotation', () => {
    const camera = {
      ...makeZeroCameraFallbackSnapshot(),
      position: vec3.create(0, 0, 5),
    };
    const projectedHeight = (world: Float32Array): number => {
      const scene = new RenderScene();
      scene.reset([{ ...snapshot(0), transform: { world } }]);
      const slot = scene.slotsSnapshot().at(0);
      if (slot === undefined) throw new Error('projection fixture did not create a slot');
      return projectedHeightForCandidate(slot, camera);
    };

    const identity = new Float32Array(mat4.identity(mat4.create()));
    const halfScale = new Float32Array(identity);
    halfScale[0] = 0.5;
    halfScale[5] = 0.5;
    halfScale[10] = 0.5;
    expect(projectedHeight(halfScale)).toBeCloseTo(projectedHeight(identity) * 0.5, 6);

    // Column-major matrix: a 90-degree Z rotation with signed, non-uniform
    // scales. The transformed AABB radius is the conservative world-space
    // bound, not the unscaled local radius.
    const rotatedScaled = new Float32Array(16);
    rotatedScaled[1] = 2;
    rotatedScaled[4] = -3;
    rotatedScaled[10] = -0.5;
    rotatedScaled[15] = 1;
    const expectedRadius = Math.hypot(1.5, 1, 0.25);
    const expectedHeight = measureProjectedHeight({
      radius: expectedRadius,
      depth: 5,
      projection: camera.projection,
      fov: camera.fov,
      orthoHeight: camera.orthoTop - camera.orthoBottom,
    });
    expect(projectedHeight(rotatedScaled)).toBeCloseTo(expectedHeight, 6);
  });
});
