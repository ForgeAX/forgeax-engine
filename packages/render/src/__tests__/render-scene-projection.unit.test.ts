import { RuntimeMeshVertices } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { ChildOf, GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine-scene';
import {
  createStandardPbrArtifactReceipt,
  type MaterialShaderArtifact,
} from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import {
  Camera,
  DirectionalLight,
  Instances,
  LightProbe,
  MeshFilter,
  MeshRenderer,
  MotionBlur,
  PointLight,
  PointLightShadow,
  SpotLight,
  Visibility,
  VisibilityStateValue,
} from '../components';
import { gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import {
  freezePreparedGpuDrivenDraw,
  type PreparedGpuDrivenDraw,
} from '../gpu-driven/prepared-draw';
import {
  artifactForPreparedBatch,
  shadowArtifactForPreparedBatch,
} from '../gpu-driven/production-raster-prepare';
import { InstanceProjectionStore } from '../instances';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type {
  DispatchEntry,
  ExtractedFrame,
  MaterialSnapshot,
  RenderableSnapshot,
  ShadowCasterMembership,
} from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
  RenderScene,
} from '../scene/render-scene';
import type { SkinPaletteReceipt } from '../systems/skin-palette-types';
import { classifySceneDataCoverage } from '../temporal/coverage';

function projected<T>(value: T): Exclude<T, Error> {
  if (value instanceof Error) throw value;
  return value as Exclude<T, Error>;
}

const material = {} as MaterialSnapshot;

function emptyLights(): ExtractedFrame['lights'] {
  return {
    directional: undefined,
    directionalCount: 0,
    point: [],
    spot: [],
    rect: [],
    pointShadow: [],
    lightViewProj: undefined,
    splitPlanes: undefined,
    cascadeCount: undefined,
    cascadeBlend: undefined,
    shadowMapSize: undefined,
    depthBias: undefined,
    normalBias: undefined,
    directionalShadowQuality: undefined,
    directionalShadowError: undefined,
    directionalCsmConfig: undefined,
    directionalCsmDirection: undefined,
  };
}

const SKIN_RECEIPT = {
  identity: 'skin:0:1',
  generation: 1,
  fence: 1,
  customDataStart: 0,
  storageOrUniform: 'storage',
  jointCount: 1,
  byteOffset: 0,
  buffer: {} as never,
  dirtyRanges: [],
  uploadBytes: 0,
} satisfies SkinPaletteReceipt;

function snapshot(entityKey: number, translationX: number): RenderableSnapshot {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  world[12] = translationX;
  return {
    assetHandle: 1,
    transform: { world },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
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

function updateInstances(value: RenderableSnapshot) {
  if (value.instances === undefined) throw new Error('expected Instances payload');
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    instances: value.instances,
  };
}

function instancesSnapshot(
  entityKey: number,
  translationX: number,
  instanceCount = 1,
): RenderableSnapshot {
  const base = snapshot(entityKey, 0);
  const transforms = new Float32Array(instanceCount * 16);
  for (let index = 0; index < instanceCount; index += 1) {
    const offset = index * 16;
    transforms[offset] = 1;
    transforms[offset + 5] = 1;
    transforms[offset + 10] = 1;
    transforms[offset + 15] = 1;
    transforms[offset + 12] = translationX + index;
  }
  return {
    ...base,
    instances: {
      transforms,
      instanceCount,
      cacheKey: entityKey,
      archVersion: 0,
      revision: translationX + instanceCount,
    },
  };
}

describe('RenderScene canonical owner', () => {
  it('owns vertex inputs across source mutation and transform-only updates', () => {
    const projection = new RenderScene();
    const initial = snapshot(7, 1);
    const receipt = createStandardPbrArtifactReceipt();
    const vertexInputs = receipt.vertexInputs.map((input) => ({ ...input }));
    const prepared = {
      ...receipt,
      identity: { material: 'pbr', geometry: 'cube', deformation: 'rigid' },
      receiptGeneration: receipt.generation,
      skinPaletteAddress: receipt.skinPaletteAddress,
      vertexInputs,
      topology: 'triangle-list',
      indexed: true,
      first: 0,
      count: 36,
      baseVertex: 0,
    } satisfies PreparedGpuDrivenDraw;
    const draw = {
      kind: 'indexed' as const,
      first: 0,
      count: 36,
      baseVertex: 0,
      materialSlot: 0,
      topology: 'triangle-list' as const,
      pipelineClass: 'pbr',
      materialResourceClass: '',
      prepared,
    };
    projection.apply([updateSnapshot({ ...initial, gpuDrivenDraws: [draw] })]);
    const owned = projection.materialize()[0]?.gpuDrivenDraws?.[0]?.prepared?.vertexInputs;
    expect(owned).toEqual(vertexInputs);
    expect(owned).not.toBe(vertexInputs);
    const ownedPrepared = projection.materialize()[0]?.gpuDrivenDraws?.[0]?.prepared;
    expect(Object.isFrozen(ownedPrepared)).toBe(true);
    expect(Object.isFrozen(ownedPrepared?.identity)).toBe(true);
    if (ownedPrepared === undefined) throw new Error('missing owned prepared draw');
    const artifact = { material: 'pbr' } as MaterialShaderArtifact;
    const artifactKey = gpuDrivenMaterialArtifactKey({
      material: ownedPrepared.identity.material,
      deformation: ownedPrepared.identity.deformation,
      receiptIdentity: ownedPrepared.receiptIdentity,
      receiptGeneration: ownedPrepared.receiptGeneration,
    });
    const artifacts = new Map([[artifactKey, artifact]]);
    let serialized = 0;
    const join = Array.prototype.join;
    const keyObserver = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      separator?: string,
    ) {
      if (separator === '|' && this[0] === 'pbr' && this[1] === 'rigid') serialized++;
      return join.call(this, separator);
    });
    try {
      for (let view = 0; view < 64; view++) {
        expect(
          artifactForPreparedBatch({ prepared: ownedPrepared }, artifacts, undefined, undefined),
        ).toBe(artifact);
        expect(
          shadowArtifactForPreparedBatch({ prepared: ownedPrepared }, artifacts, undefined),
        ).toBe(artifact);
      }
    } finally {
      keyObserver.mockRestore();
    }
    expect(serialized).toBe(0);
    // Transport clones and raw changes retain their live lookup semantics.
    const borrowed = structuredClone(ownedPrepared);
    expect(shadowArtifactForPreparedBatch({ prepared: borrowed }, artifacts, undefined)).toBe(
      artifact,
    );
    Object.assign(borrowed, {
      receiptIdentity: 'replacement',
      receiptGeneration: ownedPrepared.receiptGeneration + 1,
    });
    expect(
      shadowArtifactForPreparedBatch({ prepared: borrowed }, artifacts, undefined),
    ).toBeUndefined();
    expect(shadowArtifactForPreparedBatch({ prepared: ownedPrepared }, artifacts, undefined)).toBe(
      artifact,
    );
    let generationReads = 0;
    const frozenAccessor = freezePreparedGpuDrivenDraw({
      ...ownedPrepared,
      get receiptGeneration() {
        return ownedPrepared.receiptGeneration + generationReads++;
      },
    });
    expect(generationReads).toBe(0);
    expect(shadowArtifactForPreparedBatch({ prepared: frozenAccessor }, artifacts, undefined)).toBe(
      artifact,
    );
    expect(
      shadowArtifactForPreparedBatch({ prepared: frozenAccessor }, artifacts, undefined),
    ).toBeUndefined();
    expect(generationReads).toBe(2);
    if (vertexInputs[0] === undefined) throw new Error('missing vertex input');
    Object.assign(vertexInputs[0], { location: 17 });
    projection.apply([
      { kind: 'update', worldId: 0, entityKey: 7, world: initial.transform.world },
    ]);
    expect(projection.materialize()[0]?.gpuDrivenDraws?.[0]?.prepared?.vertexInputs).toBe(owned);
    expect(owned?.[0]?.location).not.toBe(17);
    projection.apply([updateSnapshot({ ...initial, gpuDrivenDraws: [draw] })]);
    expect(
      projection.materialize()[0]?.gpuDrivenDraws?.[0]?.prepared?.vertexInputs[0]?.location,
    ).toBe(17);
  });

  it('retains a visible equipment subtree on repeated same-value Visibility writes', () => {
    const world = new World();
    const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap());
    const parent = world
      .spawn(
        { component: Transform, data: {} },
        { component: Visibility, data: { state: VisibilityStateValue.visible } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    propagateTransforms(world).unwrap();
    const lease = createRenderReadLease(world);
    const persistent = new PersistentRenderScene();
    const build = vi.fn((request: PersistentRenderCandidateRequest) =>
      extractFrames(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        undefined,
        undefined,
        undefined,
        { cull: 'none', renderables: request },
      ),
    );
    const draw = () =>
      persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, build, [
        lease,
      ]);
    try {
      expect(draw().renderables).toHaveLength(1);
      const retained = persistent.compositionSlots()[0]?.snapshot;
      for (let frame = 0; frame < 3; frame++) {
        build.mockClear();
        world.set(parent, Visibility, { state: VisibilityStateValue.visible }).unwrap();
        expect(draw().renderables).toHaveLength(1);
        expect(persistent.compositionSlots()[0]?.snapshot).toBe(retained);
        expect(build.mock.calls.map(([request]) => request)).toEqual(['none']);
      }
      world.set(parent, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
      expect(draw().renderables).toHaveLength(0);
      world.set(parent, Visibility, { state: VisibilityStateValue.visible }).unwrap();
      expect(draw().renderables).toHaveLength(1);
    } finally {
      lease.dispose();
      persistent.dispose();
    }
  });

  it('exposes current retained composition before GPU tables and fences changed or detached sources', () => {
    const world = new World();
    const lease = createRenderReadLease(world);
    const scene = new PersistentRenderScene();
    const frame = {
      cameras: [{ ...makeZeroCameraFallbackSnapshot(), worldId: 0, entityKey: 1 }],
      renderables: [],
      dispatch: [],
      hiddenEntityReports: [],
    } as unknown as ExtractedFrame;
    try {
      scene.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, () => frame, [
        lease,
      ]);
      expect(scene.compositionGpuDrivenState()).toBeUndefined();
      const retained = scene.compositionRetainedScene();
      if (retained === undefined) throw new Error('missing retained composition');
      expect(retained.worlds).toEqual([world]);
      expect(retained.isCurrent()).toBe(true);
      expect(retained.isSourceCurrent()).toBe(true);
      world.spawn({ component: Transform, data: {} }).unwrap();
      expect(retained.isSourceCurrent()).toBe(false);
      scene.detach(world);
      expect(retained.isCurrent()).toBe(false);
      expect(scene.compositionRetainedScene()).toBeUndefined();
    } finally {
      lease.dispose();
    }
  });

  it('rejects a mismatched source identity before publishing any operation', () => {
    const scene = new RenderScene();
    scene.apply([updateSnapshot(snapshot(1, 0))]);
    expect(() =>
      scene.apply([
        updateSnapshot(snapshot(1, 3)),
        { kind: 'update', worldId: 0, entityKey: 2, snapshot: snapshot(3, 4) },
      ]),
    ).toThrow('identity must match');
    expect(scene.slot(0, 1)?.snapshot.transform.world[12]).toBe(0);
    expect(scene.slot(0, 2)).toBeUndefined();
    expect(scene.slot(0, 3)).toBeUndefined();
  });

  it('rebuilds the retained composition when Motion Blur is toggled', () => {
    const world = new World();
    const camera = world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        {
          component: Camera,
          data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 },
        },
        {
          component: MotionBlur,
          data: { shutterAngle: 180, maxRadiusPixels: 32, sampleCount: 8 },
        },
      )
      .unwrap();
    const lease = createRenderReadLease(world);
    const frame = {
      cameras: [{ ...makeZeroCameraFallbackSnapshot(), worldId: 0, entityKey: camera as number }],
      lights: emptyLights(),
      renderables: [],
      dispatch: [],
      hiddenEntityReports: [],
    } as unknown as ExtractedFrame;
    const persistent = new PersistentRenderScene();
    let builds = 0;
    const build = (): ExtractedFrame => {
      builds += 1;
      return frame;
    };

    persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, build, [lease]);
    expect(builds).toBe(1);

    world.removeComponent(camera, MotionBlur).unwrap();
    world.update().unwrap();
    persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, build, [lease]);
    expect(builds).toBe(2);

    world
      .addComponent(camera, {
        component: MotionBlur,
        data: { shutterAngle: 180, maxRadiusPixels: 32, sampleCount: 8 },
      })
      .unwrap();
    world.update().unwrap();
    persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, build, [lease]);
    expect(builds).toBe(3);
    lease.dispose();
  });

  it('retains renderable topology while refreshing per-frame resources', () => {
    const world = new World();
    const lease = createRenderReadLease(world);
    const camera = { ...makeZeroCameraFallbackSnapshot(), worldId: 0, entityKey: 1 };
    const renderables = Array.from({ length: 1024 }, (_, entityKey) =>
      snapshot(entityKey + 1, entityKey * 0.01),
    );
    const frame = {
      cameras: [camera],
      lights: emptyLights(),
      renderables,
      dispatch: [],
      hiddenEntityReports: [],
    } as unknown as ExtractedFrame;
    const persistent = new PersistentRenderScene();
    let builds = 0;
    const build = (): ExtractedFrame => {
      builds += 1;
      return frame;
    };
    const first = persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      build,
      [lease],
    );
    const stable = persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      build,
      [lease],
    );

    expect(stable).not.toBe(first);
    expect(stable.renderables).toEqual(first.renderables);
    expect(builds).toBe(2);
    expect(persistent.inspect()).toMatchObject({
      worldEntitiesScanned: 0,
      noChangeFrames: 1,
      projectionRecords: 1024,
    });
    lease.dispose();
  });

  it('projects current scene contributors without owning temporal history', () => {
    const coverage = classifySceneDataCoverage({
      contributors: [{ id: 'world', kind: 'reactive' }],
      requiredContributorIds: ['world', 'camera'],
    });
    expect(coverage.reactiveContributorIds).toEqual(['world']);
    expect(coverage.missingContributorIds).toEqual(['camera']);
  });

  it('coalesces create and transform updates into one stable slot', () => {
    const projection = new RenderScene();
    const initial = snapshot(7, 1);
    const updatedWorld = new Float32Array(initial.transform.world);
    updatedWorld[12] = 9;

    const result = projection.apply([
      updateSnapshot(initial),
      { kind: 'update', worldId: 0, entityKey: 7, world: updatedWorld },
    ]);

    expect(result).toMatchObject({ created: 1, updated: 0, removed: 0, recreated: 0 });
    expect(projection.inspect().records).toEqual([
      expect.objectContaining({ slot: 0, generation: 0, worldId: 0, entityKey: 7 }),
    ]);
    expect(projection.materialize()[0]?.transform.world[12]).toBe(9);
  });

  it('keeps mixed Instances and transform updates on the instance lane', () => {
    const initial = instancesSnapshot(7, 1);
    const nextInstances = instancesSnapshot(7, 4);
    const nextWorld = new Float32Array(initial.transform.world);
    nextWorld[12] = 9;
    nextInstances.transform.world[12] = 9;

    for (const operations of [
      [
        updateInstances(nextInstances),
        { kind: 'update' as const, worldId: 0, entityKey: 7, world: nextWorld },
      ],
      [
        { kind: 'update' as const, worldId: 0, entityKey: 7, world: nextWorld },
        updateInstances(nextInstances),
      ],
    ]) {
      const projection = new RenderScene();
      projection.apply([updateSnapshot(initial)]);
      const result = projection.apply(operations);
      expect(result.instanceUpdatedSlots).toHaveLength(1);
      expect(result.contentUpdatedSlots).toHaveLength(0);
      expect(projection.materialize()[0]?.transform.world[12]).toBe(9);
      expect(projection.materialize()[0]?.instances?.transforms[12]).toBe(4);
    }
  });

  it('does not downgrade a full update followed by an Instances update', () => {
    const projection = new RenderScene();
    projection.apply([updateSnapshot(instancesSnapshot(7, 1))]);
    const result = projection.apply([
      updateSnapshot(instancesSnapshot(7, 2)),
      updateInstances(instancesSnapshot(7, 3)),
    ]);

    expect(result.instanceUpdatedSlots).toHaveLength(0);
    expect(result.contentUpdatedSlots).toHaveLength(1);
  });

  it('classifies an Instances-only collection revision without widening the content update', () => {
    const world = new World();
    const instanceCollections = new InstanceProjectionStore();
    const initialTransforms = new Float32Array(16);
    initialTransforms[0] = 1;
    initialTransforms[5] = 1;
    initialTransforms[10] = 1;
    initialTransforms[15] = 1;
    const entity = world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: MeshFilter, data: { assetHandle: 1 as never } },
        { component: MeshRenderer, data: { materials: [] } },
        { component: Instances, data: { transforms: initialTransforms } },
      )
      .unwrap();
    const lease = createRenderReadLease(world);
    const requests: PersistentRenderCandidateRequest[] = [];
    const build = (request: PersistentRenderCandidateRequest): ExtractedFrame => {
      requests.push(request);
      const detached = projected(
        instanceCollections.project(
          world,
          entity,
          world.get(entity, Instances).unwrap().transforms,
        ),
      );
      return {
        cameras: [{ ...makeZeroCameraFallbackSnapshot(), worldId: 0, entityKey: 1 }],
        lights: emptyLights(),
        renderables: [
          {
            ...snapshot(entity as number, 0),
            instances: {
              ...detached,
              instanceCount: detached.count,
              cacheKey: entity as number,
              archVersion: 0,
            },
          },
        ],
        dispatch: [],
        hiddenEntityReports: [],
      } as unknown as ExtractedFrame;
    };
    const persistent = new PersistentRenderScene({ instanceCollections });
    try {
      persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, build, [
        lease,
      ]);
      const nextTransforms = new Float32Array(initialTransforms);
      nextTransforms[12] = 4;
      world.set(entity, Instances, { transforms: nextTransforms }).unwrap();
      persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, build, [
        lease,
      ]);

      let partial: Extract<PersistentRenderCandidateRequest, { kind: 'partial' }> | undefined;
      for (let index = requests.length - 1; index >= 0; index -= 1) {
        const request = requests[index];
        if (
          request !== undefined &&
          request !== 'full' &&
          request !== 'none' &&
          request.kind === 'partial'
        ) {
          partial = request;
          break;
        }
      }
      expect(partial?.kind).toBe('partial');
      if (partial?.kind !== 'partial') return;
      expect(partial.entitiesByWorld?.[0]?.has(entity as number)).toBe(true);
    } finally {
      lease.dispose();
      persistent.dispose();
      instanceCollections.dispose();
    }
  });

  it('updates cached dynamic world bounds without replacing the bounds object', () => {
    const projection = new RenderScene();
    const initial = {
      ...snapshot(7, 1),
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    };
    projection.apply([updateSnapshot(initial)]);
    const retained = projection.materialize()[0];
    if (retained === undefined) throw new Error('expected retained snapshot');
    const first = projection.cullingWorldBounds(retained);
    const moved = new Float32Array(initial.transform.world);
    moved[12] = 9;

    projection.apply([], [{ worldId: 0, entities: new Uint32Array([7]), worlds: moved }]);

    const next = projection.cullingWorldBounds(retained);
    expect(next).toBe(first);
    expect(next?.min[0]).toBe(8);
    expect(next?.max[0]).toBe(10);
  });

  it('cancels a transient create/remove pair without allocating a slot', () => {
    const projection = new RenderScene();

    const result = projection.apply([
      updateSnapshot(snapshot(3, 1)),
      { kind: 'remove', worldId: 0, entityKey: 3 },
    ]);

    expect(result).toMatchObject({ created: 0, updated: 0, removed: 0, recreated: 0 });
    expect(projection.inspect().records).toEqual([]);
  });

  it('bumps generation when remove and recreate reuse a slot', () => {
    const projection = new RenderScene();
    projection.apply([updateSnapshot(snapshot(5, 1))]);
    const before = projection.inspect().records[0];

    const result = projection.apply([
      { kind: 'remove', worldId: 0, entityKey: 5 },
      updateSnapshot(snapshot(5, 2)),
      { kind: 'update', worldId: 0, entityKey: 5, world: snapshot(5, 7).transform.world },
    ]);

    const after = projection.inspect().records[0];
    expect(result).toMatchObject({ created: 0, updated: 0, removed: 0, recreated: 1 });
    expect(after?.slot).toBe(before?.slot);
    expect(after?.generation).toBe((before?.generation ?? -1) + 1);
    expect(projection.materialize()[0]?.transform.world[12]).toBe(7);
  });

  it('ignores an update that arrives after removal', () => {
    const projection = new RenderScene();
    projection.apply([updateSnapshot(snapshot(9, 1))]);

    const result = projection.apply([
      { kind: 'remove', worldId: 0, entityKey: 9 },
      { kind: 'update', worldId: 0, entityKey: 9, world: snapshot(9, 4).transform.world },
    ]);

    expect(result).toMatchObject({ removed: 1, ignoredLateUpdates: 1 });
    expect(projection.inspect().records).toEqual([]);
  });

  it('keeps identical entity handles isolated by World identity', () => {
    const projection = new RenderScene();
    projection.apply([
      updateSnapshot(snapshot(1, 3)),
      updateSnapshot({ ...snapshot(1, 8), worldId: 1 }),
    ]);

    expect(projection.materialize().map((record) => record.transform.world[12])).toEqual([3, 8]);
  });

  it('notifies the GPU residency owner for shared-ref payload mutations', () => {
    const world = new World();
    const lease = createRenderReadLease(world);
    const handle = world.allocSharedRef('MeshAsset', { kind: 'mesh' });
    const onRuntimeAssetChange = vi.fn();
    const persistent = new PersistentRenderScene({ onRuntimeAssetChange });
    const frame = {
      cameras: [],
      lights: emptyLights(),
      renderables: [],
      dispatch: [],
      hiddenEntityReports: [],
    } as unknown as ExtractedFrame;

    persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, () => frame, [
      lease,
    ]);
    world.spawn({ component: RuntimeMeshVertices, data: { asset: handle, vertices: [] } }).unwrap();
    persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, () => frame, [
      lease,
    ]);

    expect(onRuntimeAssetChange).toHaveBeenCalledWith(0, handle);
    lease.dispose();
    persistent.dispose();
  });

  it('reuses a stable skinned composition and rebuilds when a joint changes', () => {
    const world = new World();
    const renderable = world
      .spawn({
        component: Transform,
        data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      })
      .unwrap();
    const joint = world
      .spawn({
        component: Transform,
        data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      })
      .unwrap();
    const lease = createRenderReadLease(world);
    const candidate = {
      ...snapshot(renderable as number, 0),
      skin: SKIN_RECEIPT,
      skinJointEntities: [joint as number],
    } satisfies RenderableSnapshot;
    const frame = (): ExtractedFrame =>
      ({
        cameras: [],
        auxiliaryCameras: [],
        cubeCameras: [],
        lights: {
          directional: undefined,
          directionalCount: 0,
          point: [],
          spot: [],
          pointShadow: [],
        },
        environment: undefined,
        environmentReady: true,
        renderables: [candidate],
        dispatch: [],
        shadowCasterEntityKeys: new Set<number>(),
        shadowCasterDrawKeys: new Set<string>(),
        skylight: undefined,
        skylightCount: 0,
        skybox: undefined,
        skyboxCount: 0,
        fog: undefined,
        frustumStats: { culled: 0, total: 1 },
        visibilityStats: { explicitlyHidden: 0 },
        postProcessParams: new Map(),
        visibilitySnapshots: [],
        featureVisibilitySnapshots: [],
        hiddenEntityReports: [],
      }) as unknown as ExtractedFrame;
    const persistent = new PersistentRenderScene();
    let builds = 0;
    const buildCandidate = (): ExtractedFrame => {
      builds += 1;
      return frame();
    };

    persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      buildCandidate,
      [lease],
    );
    persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      buildCandidate,
      [lease],
    );
    expect(builds).toBe(2);
    expect(persistent.inspect()).toMatchObject({
      fullRebuilds: 1,
      worldEntitiesScanned: 0,
    });

    world.set(joint, Transform, { pos: [1, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    world.update().unwrap();
    persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      buildCandidate,
      [lease],
    );
    expect(builds).toBe(4);
    expect(persistent.inspect()).toMatchObject({
      fullRebuilds: 1,
      worldEntitiesScanned: 0,
    });
    lease.dispose();
    persistent.dispose();
  });

  it('refreshes camera and light facts through normal extraction with stable scene identity', () => {
    const world = new World();
    const renderable = world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }).unwrap();
    const light = world
      .spawn(
        { component: Transform, data: { pos: [1, 2, 3] } },
        { component: PointLight, data: { intensity: 1, range: 10 } },
      )
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    propagateTransforms(world).unwrap();
    const lease = createRenderReadLease(world);
    const candidate = {
      ...snapshot(renderable as number, 0),
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    } satisfies RenderableSnapshot;
    let builds = 0;
    const buildCandidate = (): ExtractedFrame => {
      builds += 1;
      const lightTransform = world.get(light, GlobalTransform).unwrap();
      const cameraTransform = world.get(camera, GlobalTransform).unwrap();
      return {
        cameras: [
          {
            ...makeZeroCameraFallbackSnapshot(),
            worldId: 0,
            entityKey: camera as number,
            world: new Float32Array(cameraTransform.world),
          },
        ],
        auxiliaryCameras: [],
        cubeCameras: [],
        lights: {
          directional: undefined,
          directionalCount: 0,
          point: [
            {
              kind: 'point',
              entity: light,
              worldId: 0,
              position: new Float32Array([
                lightTransform.world[12] ?? 0,
                lightTransform.world[13] ?? 0,
                lightTransform.world[14] ?? 0,
              ]),
              color: new Float32Array([1, 1, 1]),
              intensity: 1,
              invRangeSquared: 0.01,
            },
          ],
          spot: [],
          pointShadow: [],
          rect: [],
        },
        environment: undefined,
        environmentReady: true,
        renderables: [candidate],
        dispatch: [],
        shadowCasterEntityKeys: new Set<number>(),
        shadowCasterDrawKeys: new Set<string>(),
        skylight: undefined,
        skylightCount: 0,
        skybox: undefined,
        skyboxCount: 0,
        fog: undefined,
        frustumStats: { culled: 0, total: 1 },
        visibilityStats: { explicitlyHidden: 0 },
        postProcessParams: new Map(),
        visibilitySnapshots: [],
        featureVisibilitySnapshots: [],
        hiddenEntityReports: [],
      } as unknown as ExtractedFrame;
    };
    const persistent = new PersistentRenderScene();
    try {
      const initial = persistent.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        0,
        buildCandidate,
        [lease],
      );
      const before = persistent.compositionSlots()[0];
      expect(before).toBeDefined();
      world.set(light, Transform, { pos: [4, 2, 3] }).unwrap();
      propagateTransforms(world).unwrap();
      const moved = persistent.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        0,
        buildCandidate,
        [lease],
      );
      expect(moved.lights.point[0]?.position[0]).toBeCloseTo(4);
      expect(builds).toBe(2);

      world.set(camera, Transform, { pos: [0, 1, 5] }).unwrap();
      propagateTransforms(world).unwrap();
      const cameraMoved = persistent.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        0,
        buildCandidate,
        [lease],
      );
      expect(cameraMoved.cameras[0]?.world[13]).toBeCloseTo(1);
      const after = persistent.compositionSlots()[0];
      expect(after).toMatchObject({ slot: before?.slot, generation: before?.generation });
      const projected = persistent.projectVisibility(
        [world],
        cameraMoved.renderables,
        cameraMoved.dispatch,
      );
      expect(projected.renderables).toEqual(cameraMoved.renderables);
      expect(projected.dispatch).toEqual(cameraMoved.dispatch);
      expect(initial.renderables).toHaveLength(1);
      // Transform spans update poses without a second source-identity scan.
      expect(persistent.inspect()).toMatchObject({ fullRebuilds: 1, worldEntitiesScanned: 0 });
    } finally {
      lease.dispose();
      persistent.dispose();
    }
  });

  it('refreshes camera, light, and shadow facts through normal extraction per World identity', () => {
    const makeWorld = (position: [number, number, number]) => {
      const world = new World();
      const entity = world
        .spawn(
          { component: Transform, data: { pos: position } },
          { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
          { component: DirectionalLight, data: { castShadow: true, direction: [0.2, -1, 0.3] } },
          { component: PointLight, data: {} },
          { component: PointLightShadow, data: {} },
          { component: SpotLight, data: { castShadow: true, direction: [0, -1, 0] } },
          {
            component: LightProbe,
            data: { irradiance: new Float32Array(27).fill(0.25), radius: 10 },
          },
        )
        .unwrap();
      propagateTransforms(world).unwrap();
      world.update().unwrap();
      return { world, entity };
    };
    const first = makeWorld([1, 2, 3]);
    const second = makeWorld([20, 2, 3]);
    expect(Number(first.entity)).toBe(Number(second.entity));
    const worlds = [first.world, second.world] as const;
    const leases = [
      createRenderReadLease(first.world),
      createRenderReadLease(second.world),
    ] as const;
    const persistent = new PersistentRenderScene();
    const build = (request: PersistentRenderCandidateRequest) =>
      extractFrames(worlds, { cameraOwner: 0, resourceOwner: 0 }, undefined, undefined, undefined, {
        cull: 'none',
        renderables: request,
      });
    try {
      const previous = persistent.extractComposition(
        worlds,
        { cameraOwner: 0, resourceOwner: 0 },
        0,
        build,
        leases,
      );
      const previousPointShadow = previous.lights.pointShadow.find(
        (shadow) => shadow.worldId === 0,
      );
      const previousSpot = previous.lights.spot.find((light) => light.worldId === 0);
      const previousProbe = previous.lightProbes?.find((probe) => probe.worldId === 0);
      const previousWorldOnePoint = previous.lights.point.find((light) => light.worldId === 1);
      expect(previousPointShadow).toBeDefined();
      expect(previousSpot).toBeDefined();
      expect(previousProbe).toBeDefined();
      expect(previous.cameras[0]).toBeDefined();
      expect(previous.lights.lightViewProj).toBeDefined();
      expect(previousWorldOnePoint).toBeDefined();

      first.world.set(first.entity, Transform, { pos: [4, 5, 6] }).unwrap();
      propagateTransforms(first.world).unwrap();
      first.world.update().unwrap();
      const refreshed = persistent.extractComposition(
        worlds,
        { cameraOwner: 0, resourceOwner: 0 },
        0,
        build,
        leases,
      );
      const point = refreshed.lights.point.find((light) => light.worldId === 0);
      const pointShadow = refreshed.lights.pointShadow.find((shadow) => shadow.worldId === 0);
      const spot = refreshed.lights.spot.find((light) => light.worldId === 0);
      const probe = refreshed.lightProbes?.find((candidate) => candidate.worldId === 0);
      const worldOnePoint = refreshed.lights.point.find((light) => light.worldId === 1);
      expect(point?.position).toEqual(new Float32Array([4, 5, 6]));
      expect(pointShadow?.position).toEqual(new Float32Array([4, 5, 6]));
      expect(pointShadow?.shadowMatrices).not.toEqual(previousPointShadow?.shadowMatrices);
      expect(spot?.position).toEqual(new Float32Array([4, 5, 6]));
      expect(spot?.lightViewProj).not.toEqual(previousSpot?.lightViewProj);
      expect(probe?.position).toEqual([4, 5, 6]);
      expect(refreshed.cameras[0]?.world[12]).toBeCloseTo(4);
      expect(refreshed.cameras[0]?.world[13]).toBeCloseTo(5);
      expect(refreshed.lights.lightViewProj).not.toEqual(previous.lights.lightViewProj);
      expect(worldOnePoint?.position).toEqual(previousWorldOnePoint?.position);
      expect(refreshed.lights.point.find((light) => light.worldId === 1)?.position).not.toEqual(
        point?.position,
      );
    } finally {
      leases[0].dispose();
      leases[1].dispose();
      persistent.dispose();
    }
  });

  it('retains the complete shadow dispatch across mixed camera and renderable refresh', () => {
    const world = new World();
    const camera = world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        {
          component: Camera,
          data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 },
        },
      )
      .unwrap();
    const visibleEntity = world
      .spawn({
        component: Transform,
        data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      })
      .unwrap();
    const hiddenEntity = world
      .spawn({
        component: Transform,
        data: { pos: [100, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      })
      .unwrap();
    propagateTransforms(world).unwrap();
    world.update().unwrap();

    const cameraSnapshot = (): ExtractedFrame['cameras'][number] => {
      const transform = world.get(camera, GlobalTransform).unwrap();
      return {
        ...makeZeroCameraFallbackSnapshot(),
        worldId: 0,
        entityKey: camera as number,
        position: vec3.create(
          transform.world[12] ?? 0,
          transform.world[13] ?? 0,
          transform.world[14] ?? 0,
        ),
        world: new Float32Array(transform.world),
        fov: Math.PI / 3,
        aspect: 1,
        near: 0.1,
        far: 100,
      };
    };
    const renderables = [
      {
        ...snapshot(visibleEntity as number, 0),
        localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      },
      {
        ...snapshot(hiddenEntity as number, 100),
        localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      },
    ];
    const [visibleSource, hiddenSource] = renderables;
    if (visibleSource === undefined || hiddenSource === undefined)
      throw new Error('missing fixture');
    const dispatch: DispatchEntry[] = renderables.map((entry, renderableIndex) => ({
      entityIndex: entry.entityKey,
      materialHandle: 0,
      renderableIndex,
      passIndex: 0,
      queue: 2000,
      layer: 0,
      tags: { LightMode: 'ShadowCaster' },
      renderState: undefined,
      defines: undefined,
      vertexEntry: 'vs_main',
      fragmentEntry: undefined,
      materialShaderId: 'forgeax::default-shadow-caster',
      paramSnapshot: {},
    }));
    const shadowCasterMembership: ShadowCasterMembership[] = renderables.map(
      (entry, renderableIndex) => ({
        worldEntity: entry.entityKey,
        renderableIndex,
        drawItemIndex: 0,
        materialHandle: 0,
        passIndex: 0,
      }),
    );
    const frame = (): ExtractedFrame =>
      ({
        cameras: [cameraSnapshot()],
        auxiliaryCameras: [],
        cubeCameras: [],
        lights: {
          directional: undefined,
          directionalCount: 0,
          point: [],
          spot: [],
          pointShadow: [],
        },
        environment: undefined,
        environmentReady: true,
        renderables,
        dispatch,
        shadowCasterEntityKeys: new Set(renderables.map((entry) => entry.entityKey)),
        shadowCasterDrawKeys: new Set(
          shadowCasterMembership.map(
            (entry) =>
              `${entry.worldEntity}:${entry.materialHandle}:${entry.drawItemIndex}:${entry.passIndex}`,
          ),
        ),
        shadowCasterMembership,
        skylight: undefined,
        skylightCount: 0,
        skybox: undefined,
        skyboxCount: 0,
        fog: undefined,
        frustumStats: { culled: 0, total: 2 },
        visibilityStats: { explicitlyHidden: 0 },
        postProcessParams: new Map(),
        visibilitySnapshots: [],
        featureVisibilitySnapshots: [],
        hiddenEntityReports: [],
      }) as unknown as ExtractedFrame;
    const lease = createRenderReadLease(world);
    const persistent = new PersistentRenderScene();
    const initial = persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      frame,
      [lease],
    );
    expect(initial.renderables).toHaveLength(1);
    expect(initial.dispatch).toHaveLength(1);
    expect(persistent.shadowCasterProjection()?.dispatch).toHaveLength(2);
    expect(persistent.shadowCasterProjection()?.worldBoundsOf(hiddenSource)).toEqual({
      min: [99, -1, -1],
      max: [101, 1, 1],
    });

    world.set(camera, Transform, { pos: [0, 0, 4] }).unwrap();
    propagateTransforms(world).unwrap();
    world.update().unwrap();
    const moved = persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      frame,
      [lease],
    );

    expect(moved.renderables).toHaveLength(1);
    expect(moved.dispatch).toHaveLength(1);
    expect(persistent.shadowCasterProjection()?.dispatch).toHaveLength(2);
    expect(persistent.shadowCasterProjection()?.worldBoundsOf(hiddenSource)).toEqual({
      min: [99, -1, -1],
      max: [101, 1, 1],
    });

    // A renderable and the camera can change in the same ECS tick. Normal
    // extraction updates both through the retained projection, so the complete
    // shadow dispatch remains available after the delta updates the slot.
    world.set(camera, Transform, { pos: [0, 0, 3] }).unwrap();
    world.set(visibleEntity, Transform, { pos: [1, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    world.update().unwrap();
    const mixed = persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      frame,
      [lease],
    );

    expect(mixed.renderables).toHaveLength(1);
    expect(mixed.dispatch).toHaveLength(1);
    expect(persistent.shadowCasterProjection()?.dispatch).toHaveLength(2);
    expect(persistent.shadowCasterProjection()?.worldBoundsOf(hiddenSource)).toEqual({
      min: [99, -1, -1],
      max: [101, 1, 1],
    });
    expect(persistent.shadowCasterProjection()?.worldBoundsOf(visibleSource)).toEqual({
      min: [0, -1, -1],
      max: [2, 1, 1],
    });
    lease.dispose();
    persistent.dispose();
  });

  it('rebuilds probe records when a LightProbe transform changes', () => {
    const world = new World();
    const renderableEntity = world
      .spawn({
        component: Transform,
        data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      })
      .unwrap();
    const nearProbe = world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        {
          component: LightProbe,
          data: { irradiance: new Float32Array(27).fill(1), radius: 2 },
        },
      )
      .unwrap();
    const farProbe = world
      .spawn(
        {
          component: Transform,
          data: { pos: [4, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        {
          component: LightProbe,
          data: { irradiance: new Float32Array(27), radius: 10 },
        },
      )
      .unwrap();
    propagateTransforms(world).unwrap();
    const lease = createRenderReadLease(world);
    const renderable = {
      ...snapshot(renderableEntity as number, 0),
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    };
    const probeFact = (entity: typeof nearProbe | typeof farProbe) => {
      const transform = world.get(entity, GlobalTransform).unwrap();
      const probe = world.get(entity, LightProbe).unwrap();
      return {
        identity: String(entity),
        worldId: 0,
        position: [
          transform.world[12] ?? 0,
          transform.world[13] ?? 0,
          transform.world[14] ?? 0,
        ] as [number, number, number],
        radius: probe.radius,
        irradiance: new Float32Array(probe.irradiance),
        admitted: true,
      };
    };
    const buildFrame = (): ExtractedFrame =>
      ({
        cameras: [],
        lights: {
          directional: undefined,
          directionalCount: 0,
          point: [],
          spot: [],
          pointShadow: [],
        },
        environment: undefined,
        environmentReady: true,
        renderables: [renderable],
        dispatch: [],
        lightProbes: [probeFact(nearProbe), probeFact(farProbe)],
        skylight: undefined,
        skylightCount: 0,
        skybox: undefined,
        skyboxCount: 0,
        fog: undefined,
        frustumStats: { culled: 0, total: 1 },
        visibilityStats: { explicitlyHidden: 0 },
        postProcessParams: new Map(),
        visibilitySnapshots: [],
        featureVisibilitySnapshots: [],
        hiddenEntityReports: [],
      }) as unknown as ExtractedFrame;
    const persistent = new PersistentRenderScene();
    const initial = persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      buildFrame,
      [lease],
    );
    const initialRecord = initial.renderables[0]?.probeBlendRecord;
    expect(initialRecord).toBeDefined();

    world.set(nearProbe, Transform, { pos: [4, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    world.update().unwrap();
    const moved = persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      buildFrame,
      [lease],
    );

    expect(persistent.inspect()).toMatchObject({ fullRebuilds: 1 });
    expect(moved.renderables[0]?.probeBlendRecord?.bytes).not.toEqual(initialRecord?.bytes);
    lease.dispose();
    persistent.dispose();
  });
});

describe('RenderScene', () => {
  it('retains attached probe records through persistent frustum culling', () => {
    const scene = new PersistentRenderScene();
    const renderable = {
      ...snapshot(7, 0),
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    };
    const frame = {
      cameras: [],
      renderables: [renderable],
      dispatch: [],
      lightProbes: [
        {
          identity: 'probe-a',
          position: [0, 0, 0] as const,
          radius: 2,
          irradiance: new Float32Array(27).fill(1),
          admitted: true,
        },
      ],
      hiddenEntityReports: [],
    } as unknown as ExtractedFrame;

    const projected = scene.extractComposition(
      [new World()],
      { cameraOwner: 0, resourceOwner: 0 },
      0,
      () => frame,
    );

    expect(projected.renderables[0]?.probeBlendRecord).toMatchObject({
      objectKey: 0,
      localBlendFraction: 1,
      accepted: true,
    });
  });

  it('keeps world identity slots stable across a composition reorder', () => {
    const scene = new RenderScene();
    const first = snapshot(1, 3);
    const second = { ...snapshot(1, 8), worldId: 1 };

    scene.reset([first, second]);
    const before = scene.slot(0, 1);
    scene.reset([second, first]);

    expect(scene.slotsSnapshot().map((entry) => [entry.worldId, entry.entityKey])).toEqual([
      [1, 1],
      [0, 1],
    ]);
    expect(scene.slot(0, 1)).toMatchObject({
      slot: before?.slot,
      generation: before?.generation,
    });
  });

  it('keeps one stable slot across reorder and reports no-change without scanning', () => {
    const scene = new RenderScene();
    scene.apply([
      updateSnapshot(snapshot(7, 1)),
      updateSnapshot({ ...snapshot(8, 2), worldId: 1 }),
    ]);

    const before = scene.slot(0, 7);
    scene.apply([]);
    const after = scene.slot(0, 7);

    expect(after).toMatchObject({ slot: before?.slot, generation: before?.generation });
    expect(scene.inspect()).toMatchObject({ noChangeFrames: 1, renderableScans: 0 });
  });

  it('indexes material and spatial facts from the same scene slots', () => {
    const scene = new RenderScene();
    scene.apply([
      {
        ...updateSnapshot({
          ...snapshot(11, 4),
          localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
          material: { ...material, materialHandle: 42 },
          materials: [{ ...material, materialHandle: 42 }],
        }),
      },
    ]);

    expect(scene.slotsForMaterial(42)).toHaveLength(1);
    expect(
      scene.querySpatial({ min: [2, -2, -2], max: [6, 2, 2] }).map((entry) => entry.entityKey),
    ).toEqual([11]);
  });

  it('refreshes spatial facts when a transform delta moves a slot', () => {
    const scene = new RenderScene();
    const initial = {
      ...snapshot(12, 0),
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    };
    scene.apply([updateSnapshot(initial)]);

    expect(scene.querySpatial({ min: [-2, -2, -2], max: [2, 2, 2] })).toHaveLength(1);

    const moved = new Float32Array(initial.transform.world);
    moved[12] = 10;
    scene.apply([{ kind: 'update', worldId: 0, entityKey: 12, world: moved }]);

    expect(scene.querySpatial({ min: [-2, -2, -2], max: [2, 2, 2] })).toEqual([]);
    expect(scene.querySpatial({ min: [9, -2, -2], max: [11, 2, 2] })).toHaveLength(1);
  });
});

describe('projected bounds query', () => {
  it('uses World identity, instance transforms, and detached current projection data', () => {
    const scene = new PersistentRenderScene(),
      worldA = new World(),
      worldB = new World();
    const a = { ...snapshot(7, 10), localAabb: new Float32Array([100, -1, -2, 102, 1, 2]) };
    const b = {
      ...snapshot(7, 900),
      worldId: 1,
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    };
    const frame = (renderables: RenderableSnapshot[]) =>
      ({ cameras: [], renderables, dispatch: [] }) as unknown as ExtractedFrame;
    expect(scene.bounds(worldA, 7)).toBeUndefined();
    scene.extractComposition([worldA, worldB], { cameraOwner: 0, resourceOwner: 0 }, 0, () =>
      frame([a, b]),
    );
    expect(scene.bounds(worldA, 7)).toEqual({ min: [110, -1, -2], max: [112, 1, 2] });
    expect(scene.bounds(worldB, 7)).toEqual({ min: [899, -1, -1], max: [901, 1, 1] });
    expect(scene.bounds(new World(), 7)).toBeUndefined();
    expect(scene.bounds(worldA, 99)).toBeUndefined();
    const first = scene.bounds(worldA, 7);
    if (first === undefined) throw new Error('expected projected bounds');
    Reflect.set(first.min, 0, -999);
    expect(scene.bounds(worldA, 7)?.min[0]).toBe(110);
    const instanceA = snapshot(1, 0).transform.world,
      instanceB = snapshot(2, 20).transform.world;
    const instanced = {
      ...a,
      instances: {
        transforms: new Float32Array([...instanceA, ...instanceB]),
        instanceCount: 2,
        cacheKey: 7,
        archVersion: 1,
      },
    };
    scene.extractComposition([worldA, worldB], { cameraOwner: 0, resourceOwner: 0 }, 1, () =>
      frame([instanced, b]),
    );
    expect(scene.bounds(worldA, 7)).toEqual({ min: [110, -1, -2], max: [132, 1, 2] });
    scene.extractComposition([worldB, worldA], { cameraOwner: 0, resourceOwner: 0 }, 2, () =>
      frame([
        { ...b, worldId: 0 },
        { ...instanced, worldId: 1 },
      ]),
    );
    expect(scene.bounds(worldA, 7)?.max[0]).toBe(132);
    expect(scene.bounds(worldB, 7)?.max[0]).toBe(901);
    const { localAabb: _localAabb, ...withoutBounds } = a;
    scene.extractComposition([worldA], { cameraOwner: 0, resourceOwner: 0 }, 3, () =>
      frame([withoutBounds]),
    );
    expect(scene.bounds(worldA, 7)).toBeUndefined();
    expect(scene.bounds(worldB, 7)).toBeUndefined();
    scene.dispose();
  });
});

it('does not publish an earlier transform when later CPU candidate preparation fails', () => {
  const scene = new RenderScene();
  scene.apply([updateSnapshot(snapshot(1, 0)), updateSnapshot(snapshot(2, 0))]);
  const changed = snapshot(1, 7).transform.world;
  const malformed = snapshot(2, 9);
  Object.defineProperty(malformed, 'transform', {
    get() {
      throw new Error('candidate copy failure');
    },
  });
  expect(() =>
    scene.apply([
      { kind: 'update', worldId: 0, entityKey: 1, world: changed },
      updateSnapshot(malformed),
    ]),
  ).toThrow('candidate copy failure');
  expect(scene.slot(0, 1)?.snapshot.transform.world[12]).toBe(0);
  expect(scene.slot(0, 2)?.snapshot.transform.world[12]).toBe(0);
});
