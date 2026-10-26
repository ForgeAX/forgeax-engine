import { createBoxGeometry } from '@forgeax/engine-geometry';
import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { capturedGpuDrivenBatchKey } from '../gpu-driven/batch-key';
import {
  batchLevelStride,
  batchLodLevelCount,
  batchVisibleSpan,
  GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
} from '../gpu-driven/batch-layout';
import { BatchTopology } from '../gpu-driven/batch-topology';
import {
  GPU_DRIVEN_VIEW_SHADOW_CAMERA_WGSL,
  GPU_DRIVEN_VIEW_WGSL,
  invertLightViewProjection,
} from '../gpu-driven/view-gpu';
import { MaterialResource } from '../material-resource';
import type { RenderableSnapshot } from '../render-system-extract';
import { MeshFrame } from '../scene/mesh-frame';
import { RenderScene } from '../scene/render-scene';
import { preparedPbrSnapshot } from './gpu-driven-production-fixture';
import { classifyGpuDrivenView } from './gpu-driven-view-reference';

const material = new MaterialResource({
  baseColor: vec3.create(1, 1, 1),
  metallic: 0,
  roughness: 1,
  passes: [],
  materialShaderId: 'forgeax::default-standard-pbr',
});

const materials = new Map([['plain', material]]);

function snapshot(entityKey: number, x: number, resourceClass = 'plain'): RenderableSnapshot {
  let binding = materials.get(resourceClass);
  if (binding === undefined) {
    // A distinct resource class binds distinct textures; equal facts share a batch.
    binding = new MaterialResource({
      ...material.snapshot,
      textureHandles: new Map([['baseColorTexture', 100 + materials.size]]) as never,
    });
    materials.set(resourceClass, binding);
  }
  const world = mat4.identity(mat4.create());
  world[12] = x;
  return {
    assetHandle: 7,
    transform: { world: new Float32Array(world) },
    localAabb: new Float32Array([-0.25, -0.25, -0.25, 0.25, 0.25, 0.25]),
    material: binding,
    materials: [binding],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 3,
        count: 36,
        baseVertex: -2,
        materialSlot: 0,
        topology: 'triangle-list',
        geometry: {
          receipt: { identity: 'cube', vertexInputs: [], topology: 'triangle-list', indexed: true },
          draw: { kind: 'indexed', topology: 'triangle-list', first: 3, count: 36, baseVertex: -2 },
          deformation: 'rigid',
        },
        pipelineClass: 'opaque-pbr',
        materialResourceClass: resourceClass,
      },
    ],
  };
}

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

describe('GPU-driven batch topology and CPU oracle', () => {
  it('shares one batch per LOD chain and reserves one indirect command per level', () => {
    const projection = new RenderScene();
    const lods = [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }];
    projection.apply([
      updateSnapshot({ ...snapshot(1, 0), lods }),
      updateSnapshot({ ...snapshot(2, 4), lods }),
      updateSnapshot(snapshot(3, 8)),
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const batches = topology.query(topology.sourcePlan(), undefined).batches;
    // The LOD pair shares a chain, so it shares a batch; the level is a GPU
    // choice and never splits membership. The chain-less member stays apart.
    expect(batches).toHaveLength(2);
    const lodBatch = batches.find((batch) => batch.lod !== undefined);
    const plainBatch = batches.find((batch) => batch.lod === undefined);
    expect(lodBatch?.candidates).toHaveLength(2);
    expect(plainBatch?.candidates).toHaveLength(1);
    if (lodBatch === undefined || plainBatch === undefined) return;
    expect(batchLodLevelCount(lodBatch)).toBe(2);
    expect(batchLodLevelCount(plainBatch)).toBe(1);
    expect(batchVisibleSpan(lodBatch)).toBe(
      batchLevelStride(lodBatch) + (lodBatch.visibleAllocationCapacity ?? lodBatch.visibleCapacity),
    );
    // Commands are contiguous per batch: offsets advance by level count.
    const sorted = [...batches].sort((a, b) => a.indirectOffset - b.indirectOffset);
    expect(sorted[1]?.indirectOffset).toBe(
      (sorted[0]?.indirectOffset ?? 0) +
        batchLodLevelCount(sorted[0] ?? lodBatch) * GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
    );

    const transformOnly = projection.apply([
      {
        kind: 'update',
        worldId: 0,
        entityKey: 1,
        world: snapshot(1, 0.25).transform.world,
      },
    ]);
    expect(topology.apply(transformOnly)).toBe(false);
  });

  it('selects LOD levels and crossfade pairs on the GPU, never from a CPU height payload', () => {
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('LodViewConstants');
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('primitiveHeight(primitive, rootWorld)');
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('lodCrossfade(height, rows');
    expect(GPU_DRIVEN_VIEW_WGSL).toMatch(
      /appendVisible\(\s*candidate\.batchIndex,\s*batchWord\(candidate\.batchIndex, 0u\) \+ \(level \+ 1u\) \* batchWord\(candidate\.batchIndex, 8u\),[\s\S]*bitcast<u32>\(-lod\.fade\)/,
    );
    expect(GPU_DRIVEN_VIEW_WGSL).not.toMatch(/lodHeights|projectedHeights/);
  });

  it('projects compact visible items as scene instance, material, candidate and fade rows', () => {
    expect(GPU_DRIVEN_VIEW_WGSL).toMatch(
      /vec4<u32>\(\s*instanceIndex,\s*materialIndex,\s*candidateIndex,\s*bitcast<u32>\(lod\.fade\),/,
    );
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('materialIndex = sceneInputs[materialAddress + 0u]');
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('bitcast<f32>(sceneInputs[materialAddress + 1u])');
    expect(GPU_DRIVEN_VIEW_WGSL).not.toContain('primitives[materialAddress]');
    expect(GPU_DRIVEN_VIEW_WGSL).not.toContain('submitAdmission');
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('if (isSuppressed(candidate.sourceSlot))');
    expect(GPU_DRIVEN_VIEW_WGSL).not.toContain('instance.customDataStart');
    expect(GPU_DRIVEN_VIEW_WGSL).not.toContain('0x80000000u');
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('visibleIndices[segmentBase + localVisible]');
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('atomicStore(&counters[overflowIndex(batchIndex)], 1u)');
    expect(GPU_DRIVEN_VIEW_WGSL).toContain('visibleCount = 0u');
  });

  it('fits the portable limit of eight storage buffers per compute stage', () => {
    // WebGPU guarantees maxStorageBuffersPerShaderStage >= 8 only; a ninth
    // binding fails bind-group-layout creation on baseline adapters.
    const storage = GPU_DRIVEN_VIEW_WGSL.match(/var<storage\b/g) ?? [];
    expect(storage.length).toBeLessThanOrEqual(8);
    expect(GPU_DRIVEN_VIEW_WGSL).toContain(
      'batchWords[view.suppressionBase + (primitiveIndex >> 5u)]',
    );
  });

  it('keeps the shadow camera cull out of the module every view compiles', () => {
    // Each view builds five pipelines from the base module; only views with a
    // camera cull input pay for the larger one.
    expect(GPU_DRIVEN_VIEW_WGSL).not.toContain('cullViewShadowCamera');
    expect(GPU_DRIVEN_VIEW_WGSL).not.toContain('shadowReceiversHidden');
    expect(GPU_DRIVEN_VIEW_SHADOW_CAMERA_WGSL.startsWith(GPU_DRIVEN_VIEW_WGSL)).toBe(true);
    expect(GPU_DRIVEN_VIEW_SHADOW_CAMERA_WGSL).toContain('fn cullViewShadowCamera(');
  });

  it('patches topology only when compatibility membership changes', () => {
    const projection = new RenderScene();
    projection.apply([
      updateSnapshot(snapshot(1, 0)),
      updateSnapshot(snapshot(2, 0.5)),
      updateSnapshot(snapshot(3, 0, 'textured')),
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.inspect()).toMatchObject({ batchCount: 2, candidateCount: 3, rebuilds: 1 });
    expect(topology.query(topology.sourcePlan(), undefined)).toBe(
      topology.query(topology.sourcePlan(), undefined),
    );

    const transformOnly = projection.apply([
      {
        kind: 'update',
        worldId: 0,
        entityKey: 1,
        world: snapshot(1, 0.25).transform.world,
      },
    ]);
    expect(topology.apply(transformOnly)).toBe(false);
    expect(topology.query(topology.sourcePlan(), undefined)).toBe(
      topology.query(topology.sourcePlan(), undefined),
    );
    expect(topology.inspect().patches).toBe(0);

    const removed = projection.apply([{ kind: 'remove', worldId: 0, entityKey: 3 }]);
    expect(topology.apply(removed)).toBe(true);
    expect(topology.inspect()).toMatchObject({ batchCount: 1, candidateCount: 2, patches: 1 });
  });

  it('compacts visible primitive indices and writes portable indexed indirect args', () => {
    const projection = new RenderScene();
    projection.apply([updateSnapshot(snapshot(1, 0)), updateSnapshot(snapshot(2, 10))]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    const result = classifyGpuDrivenView(
      topology.query(topology.sourcePlan(), undefined),
      projection.slotsSnapshot(),
      planes,
    );

    expect(result).toMatchObject({
      candidateCount: 2,
      rejectedCount: 1,
      visibleCount: 1,
      overflowedBatches: [],
    });
    expect(result.visibleInstanceIndices).toHaveLength(64);
    expect([...result.visibleInstanceIndices]).toEqual(new Array(64).fill(0));
    expect([...result.batchCounters]).toEqual([1]);
    const args = new DataView(result.indirectArgs);
    expect(args.getUint32(0, true)).toBe(36);
    expect(args.getUint32(4, true)).toBe(1);
    expect(args.getUint32(8, true)).toBe(3);
    expect(args.getInt32(12, true)).toBe(-2);
    expect(args.getUint32(16, true)).toBe(0);
  });

  it('keeps multi-submesh draw items independent and writes non-indexed indirect args', () => {
    const projection = new RenderScene();
    const source = snapshot(1, 0);
    const first = source.gpuDrivenDraws?.[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    projection.apply([
      updateSnapshot({
        ...source,
        gpuDrivenDraws: [
          { ...first, kind: 'non-indexed', first: 0, count: 3 },
          { ...first, kind: 'non-indexed', first: 3, count: 6 },
        ],
      }),
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const plan = topology.query(topology.sourcePlan(), undefined);
    expect(plan.candidateCount).toBe(2);
    expect(plan.batches.length).toBe(2);
    const result = classifyGpuDrivenView(
      plan,
      projection.slotsSnapshot(),
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    );
    const firstArgs = new DataView(
      result.indirectArgs,
      plan.batches.at(0)?.indirectOffset ?? 0,
      20,
    );
    const secondArgs = new DataView(
      result.indirectArgs,
      plan.batches.at(1)?.indirectOffset ?? 0,
      20,
    );
    expect([firstArgs.getUint32(0, true), firstArgs.getUint32(8, true)]).toEqual([3, 0]);
    expect([secondArgs.getUint32(0, true), secondArgs.getUint32(8, true)]).toEqual([6, 3]);
    expect(firstArgs.getUint32(12, true)).toBe(0);
    expect(secondArgs.getUint32(12, true)).toBe(0);
  });

  it('retains source geometry even when an earlier draw uses a different program', () => {
    const source = snapshot(1, 0);
    const first = source.gpuDrivenDraws?.[0];
    expect(first).toBeDefined();
    const prepared = preparedPbrSnapshot(source).gpuDrivenDraws?.[0]?.prepared;
    if (first === undefined || prepared === undefined)
      throw Error('expected prepared draw fixture');
    const projection = new RenderScene();
    projection.apply([
      updateSnapshot({
        ...source,
        gpuDrivenDraws: [
          {
            ...first,
            drawItemIndex: 10,
            prepared: {
              ...prepared,
              identity: { material: 'custom', geometry: 'triangle', deformation: 'rigid' as const },
            },
          },
          { ...first, drawItemIndex: 20, first: 9, count: 12 },
        ],
      }),
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(
      topology
        .query(topology.sourcePlan(), undefined)
        .batches.map((batch) => batch.binding?.drawItemIndex),
    ).toEqual([10, 20]);
    expect(topology.query(topology.sourcePlan(), undefined).batches.at(1)?.key).toMatchObject({
      first: 9,
      count: 12,
    });
  });

  it('patches a source draw range swap using the retained draw identity', () => {
    const source = snapshot(1, 0);
    const first = source.gpuDrivenDraws?.[0];
    expect(first).toBeDefined();
    const prepared = preparedPbrSnapshot(source).gpuDrivenDraws?.[0]?.prepared;
    if (first === undefined || prepared === undefined)
      throw Error('expected prepared draw fixture');
    const ineligible = {
      ...first,
      drawItemIndex: 10,
      prepared: {
        ...prepared,
        identity: { material: 'custom', geometry: 'triangle', deformation: 'rigid' as const },
      },
    };
    const eligible = { ...first, drawItemIndex: 20, first: 9, count: 12 };
    const eligibleAt10 = { ...eligible, drawItemIndex: 10 };
    const ineligibleAt20 = { ...ineligible, drawItemIndex: 20 };
    const projection = new RenderScene();
    projection.apply([updateSnapshot({ ...source, gpuDrivenDraws: [ineligible, eligible] })]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const swapped = projection.apply([
      updateSnapshot({ ...source, gpuDrivenDraws: [eligibleAt10, ineligibleAt20] }),
    ]);
    expect(topology.apply(swapped)).toBe(true);
    expect(topology.inspect().patches).toBe(1);
    expect(
      topology
        .query(topology.sourcePlan(), undefined)
        .batches.find((batch) => batch.key.first === 9)?.binding?.drawItemIndex,
    ).toBe(10);
    expect(
      topology
        .query(topology.sourcePlan(), undefined)
        .batches.find((batch) => batch.key.first === 3)?.binding?.drawItemIndex,
    ).toBe(20);
  });

  it('keeps prepared material and range identity after reversing submesh order', () => {
    const source = snapshot(1, 0);
    const first = source.gpuDrivenDraws?.[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const materialA = new MaterialResource({ ...material.snapshot, materialHandle: 11 });
    const materialB = new MaterialResource({ ...material.snapshot, materialHandle: 12 });
    const orderedDraws = [
      { ...first, drawItemIndex: 4, materialSlot: 0, first: 0, count: 3 },
      { ...first, drawItemIndex: 9, materialSlot: 1, first: 3, count: 6 },
    ];
    const [orderedFirst, orderedSecond] = orderedDraws;
    if (orderedFirst === undefined || orderedSecond === undefined) return;
    const ordered = {
      ...source,
      materials: [materialA, materialB],
      material: materialA,
      gpuDrivenDraws: orderedDraws,
    };
    const reversed = {
      ...ordered,
      gpuDrivenDraws: [orderedSecond, orderedFirst],
    };
    const orderedTopology = new BatchTopology();
    const reversedTopology = new BatchTopology();
    const orderedScene = new RenderScene();
    const reversedScene = new RenderScene();
    orderedScene.apply([updateSnapshot(ordered)]);
    reversedScene.apply([updateSnapshot(reversed)]);
    orderedTopology.rebuild(orderedScene.slotsSnapshot());
    reversedTopology.rebuild(reversedScene.slotsSnapshot());
    const describe = (topology: BatchTopology) =>
      topology
        .query(topology.sourcePlan(), undefined)
        .batches.map((batch) => [
          batch.key.materialSlot,
          batch.key.first,
          batch.key.count,
          batch.candidates.at(0)?.drawItemIndex,
        ]);
    expect(describe(reversedTopology).sort()).toEqual(describe(orderedTopology).sort());
  });

  it('culls ordinary instance-local transforms and emits instance identities', () => {
    const source = snapshot(1, 0);
    const identity = mat4.identity(mat4.create());
    const outside = mat4.identity(mat4.create());
    outside[12] = 10;
    const projection = new RenderScene();
    projection.apply([
      updateSnapshot({
        ...source,
        instances: {
          transforms: new Float32Array([...identity, ...outside]),
          instanceCount: 2,
          cacheKey: 1,
          archVersion: 1,
        },
      }),
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.inspect()).toMatchObject({ candidateCount: 2, ineligible: 0 });
    const result = classifyGpuDrivenView(
      topology.query(topology.sourcePlan(), undefined),
      projection.slotsSnapshot(),
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
    );
    expect(result).toMatchObject({ candidateCount: 2, visibleCount: 1, rejectedCount: 1 });
    expect(result.visibleInstanceIndices).toHaveLength(64);
    expect([...result.visibleInstanceIndices]).toEqual(new Array(64).fill(0));
    expect(new DataView(result.indirectArgs).getUint32(4, true)).toBe(1);
  });

  it('reports overflow instead of silently accepting a truncated batch', () => {
    const projection = new RenderScene();
    projection.apply([updateSnapshot(snapshot(1, 0)), updateSnapshot(snapshot(2, 0.5))]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const plan = topology.query(topology.sourcePlan(), undefined);
    const batch = plan.batches.at(0);
    expect(batch).toBeDefined();
    if (batch === undefined) return;
    const result = classifyGpuDrivenView(
      plan,
      projection.slotsSnapshot(),
      frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
      new Map([[batch.batchId, 1]]),
    );
    expect(result.overflowedBatches).toEqual([batch.batchId]);
    expect(result.visibleCount).toBe(1);
  });

  it('keeps the ineligible inspection bounded to current projection membership', () => {
    const projection = new RenderScene();
    const { localAabb: _localAabb, ...withoutBounds } = snapshot(1, 0);
    const topology = new BatchTopology();
    topology.rebuild(projection.apply([updateSnapshot(withoutBounds)]).createdSlots);
    expect(topology.inspect().ineligible).toBe(1);

    const removed = projection.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
    topology.apply(removed);
    expect(topology.inspect().ineligible).toBe(0);
  });
});

describe('shadow camera cull light inverse', () => {
  function roundTrip(lightViewProjection: Float32Array, world: readonly number[]): number[] {
    const inverse = invertLightViewProjection(lightViewProjection);
    if (inverse === undefined) throw new Error('expected an inverse');
    const clip = mat4.multiply(
      mat4.create(),
      lightViewProjection,
      mat4.fromTranslation(mat4.create(), world),
    );
    const ndc = [12, 13, 14].map((index) => (clip[index] as number) / (clip[15] as number));
    const back = mat4.multiply(mat4.create(), inverse, mat4.fromTranslation(mat4.create(), ndc));
    return [12, 13, 14].map((index) => (back[index] as number) / (back[15] as number));
  }

  it('inverts a kilometre cascade that mat4.invert reports as singular', () => {
    const projection = mat4.orthographicReverseZ(mat4.create(), -500, 500, 500, -500, 0, 2000);
    const view = mat4.lookAt(mat4.create(), [300, 900, 200], [300, 0, 200], [0, 0, -1]);
    const light = mat4.multiply(mat4.create(), projection, view);
    expect(mat4.invert(mat4.create(), light)).toEqual(mat4.identity(mat4.create()));
    const point = roundTrip(light, [420, -30, -150]);
    expect(point[0]).toBeCloseTo(420, 1);
    expect(point[1]).toBeCloseTo(-30, 1);
    expect(point[2]).toBeCloseTo(-150, 1);
  });

  it('inverts a spot perspective', () => {
    const projection = mat4.perspectiveReverseZ(mat4.create(), 0.8, 1, 0.1, 50);
    const view = mat4.lookAt(mat4.create(), [0, 5, 0], [0, 0, 0], [0, 0, -1]);
    const point = roundTrip(mat4.multiply(mat4.create(), projection, view), [0.5, 1, -0.25]);
    expect(point[0]).toBeCloseTo(0.5, 3);
    expect(point[1]).toBeCloseTo(1, 3);
    expect(point[2]).toBeCloseTo(-0.25, 3);
  });

  it('rejects a singular light so the kernel admits every caster', () => {
    const singular = mat4.identity(mat4.create());
    singular[10] = 0;
    expect(invertLightViewProjection(singular)).toBeUndefined();
    expect(invertLightViewProjection(new Float32Array(16))).toBeUndefined();
  });
});

it('captures native batch keys without admitting borrowed mutable or frozen copies', () => {
  const scene = new RenderScene();
  scene.apply([updateSnapshot(snapshot(1, 0))]);
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const meshes = new MeshFrame().with(0, 7, createBoxGeometry(0.5, 0.5, 0.5).unwrap(), [material]);
  const batch = topology.query(topology.sourcePlan(), meshes).batches.at(0);
  const key = batch?.key;
  expect(key).toBeDefined();
  if (key === undefined || batch === undefined) return;
  expect(Object.isFrozen(key)).toBe(true);
  expect(capturedGpuDrivenBatchKey(batch)).toBe(JSON.stringify(key));
  expect(capturedGpuDrivenBatchKey({ ...batch })).toBeUndefined();
  expect(capturedGpuDrivenBatchKey(Object.freeze({ ...batch }))).toBeUndefined();
});
