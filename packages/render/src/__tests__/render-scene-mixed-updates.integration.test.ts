import { AssetRegistry, HANDLE_CUBE, RuntimeMaterialValue } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { ChildOf, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  Camera,
  Instances,
  MeshFilter,
  MeshRenderer,
  MotionBlur,
  Visibility,
  VisibilityStateValue,
} from '../components';
import { InstanceProjectionStore } from '../instances';
import type { ExtractedFrame } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../scene/render-scene';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function matrices(count: number, x: number): Float32Array {
  const result = new Float32Array(count * 16);
  for (let index = 0; index < count; index += 1) {
    result.set(IDENTITY, index * 16);
    result[index * 16 + 12] = x + index;
  }
  return result;
}

function material(values: Record<string, unknown>): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: values as NonNullable<MaterialAsset['values']>,
  };
}

function createWorld(withCamera: boolean) {
  const world = new World();
  registerPropagateTransforms(world);
  const values: Record<string, unknown> = {
    baseColor: [1, 0, 0, 1],
    metallic: 0,
    roughness: 0.5,
  };
  const materialAsset = material(values);
  const materialHandle = world.allocSharedRef('MaterialAsset', materialAsset);

  if (withCamera) {
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 20] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
        { component: MotionBlur, data: { shutterAngle: 180 } },
      )
      .unwrap();
  }

  const parentA = world
    .spawn(
      { component: Transform, data: { pos: [-1, 0, 0] } },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  const parentB = world
    .spawn(
      { component: Transform, data: { pos: [1, 0, 0] } },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  const mixed = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: ChildOf, data: { parent: parentA } },
      { component: Visibility, data: { state: VisibilityStateValue.inherited } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
      { component: Instances, data: { transforms: matrices(2, 0) } },
    )
    .unwrap();
  const sharedConsumer = world
    .spawn(
      { component: Transform, data: { pos: [0.5, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();
  const hiddenTarget = world
    .spawn(
      { component: Transform, data: { pos: [-0.5, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  const untouched = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -0.5] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();

  world.update(0).unwrap();
  return {
    world,
    values,
    materialHandle,
    mixed,
    sharedConsumer,
    hiddenTarget,
    untouched,
    parentA,
    parentB,
  };
}

function renderableFacts(frame: ExtractedFrame) {
  return frame.renderables
    .map((row) => ({
      key: `${row.worldId}:${row.entityKey}`,
      authorVisible: row.authorVisible !== false,
      world: [...row.transform.world],
      instances:
        row.instances === undefined
          ? undefined
          : {
              count: row.instances.instanceCount,
              transforms: [...row.instances.transforms],
            },
      material: {
        handle: row.material.materialHandle,
        baseColor: [...row.material.baseColor],
      },
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function frameFacts(frame: ExtractedFrame) {
  return {
    cameras: frame.cameras.map((camera) => ({
      worldId: camera.worldId,
      entityKey: camera.entityKey,
      position: [...camera.position],
      exposure: camera.exposure,
    })),
    renderables: renderableFacts(frame),
  };
}

function rowFor(frame: ExtractedFrame, worldId: number, entityKey: EntityHandle) {
  return frame.renderables.find((row) => row.worldId === worldId && row.entityKey === entityKey);
}

describe('PersistentRenderScene mixed World updates', () => {
  it('publishes instance inspection only with the accepted Scene and retires removed components', () => {
    const { world, mixed } = createWorld(true);
    const instanceCollections = new InstanceProjectionStore();
    const scene = new PersistentRenderScene({ instanceCollections });
    const lease = createRenderReadLease(world);
    const owner = { cameraOwner: 0, resourceOwner: 0 };
    let rejectCandidate = false;
    const build = (request: PersistentRenderCandidateRequest) => {
      const frame = extractFrames([world], owner, undefined, undefined, undefined, {
        cull: 'none',
        retainHidden: true,
        renderables: request,
        instanceCollections,
      });
      if (rejectCandidate && request !== 'none') throw new Error('reject prepared candidate');
      return frame;
    };
    const draw = () => scene.extractComposition([world], owner, 0, build, [lease]);
    try {
      draw();
      const before = instanceCollections._inspections(0);
      expect(before).toHaveLength(1);
      world.set(mixed, Instances, { transforms: matrices(3, 9) }).unwrap();
      rejectCandidate = true;
      expect(draw).toThrow('reject prepared candidate');
      expect(instanceCollections._inspections(0)).toEqual(before);
      rejectCandidate = false;
      expect(rowFor(draw(), 0, mixed)?.instances?.instanceCount).toBe(3);
      expect(instanceCollections._inspections(0)[0]?.revision).toBe((before[0]?.revision ?? 0) + 1);
      world.removeComponent(mixed, Instances).unwrap();
      draw();
      expect(instanceCollections._inspections(0)).toEqual([]);
      world
        .addComponent(mixed, { component: Instances, data: { transforms: matrices(1, 2) } })
        .unwrap();
      draw();
      expect(instanceCollections._inspections(0)[0]?.collectionId).not.toBe(
        before[0]?.collectionId,
      );
      world.despawn(mixed).unwrap();
      draw();
      expect(instanceCollections._inspections(0)).toEqual([]);
    } finally {
      lease.dispose();
      scene.dispose();
      instanceCollections.dispose();
    }
  });

  it('reconciles mixed fields against a fresh extract while retaining other slot history', () => {
    const instanceCollections = new InstanceProjectionStore();
    const first = createWorld(true);
    const second = createWorld(false);
    const worlds = [first.world, second.world] as const;
    const leases = [
      createRenderReadLease(first.world),
      createRenderReadLease(second.world),
    ] as const;
    const owner = { cameraOwner: 0, resourceOwner: 0 } as const;
    const scene = new PersistentRenderScene({ instanceCollections });
    const requests: PersistentRenderCandidateRequest[] = [];
    const materialCaches = scene.materialSnapshotCacheStore();
    const assets = new AssetRegistry({
      materialArtifact: () => undefined,
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);

    const build = (request: PersistentRenderCandidateRequest) => {
      requests.push(request);
      const result = extractFrames(worlds, owner, assets, undefined, materialCaches, {
        cull: 'none',
        retainHidden: true,
        renderables: request,
        instanceCollections,
      });
      return result;
    };
    const draw = () => scene.extractComposition(worlds, owner, 0, build, leases);
    const oracle = () =>
      extractFrames(worlds, owner, assets, undefined, undefined, {
        cull: 'none',
        retainHidden: true,
        renderables: 'full',
        instanceCollections,
      });
    const drawableOracle = () => {
      const frame = oracle();
      return {
        ...frame,
        renderables: frame.renderables.filter((row) => row.authorVisible !== false),
      };
    };
    const submit = (frame: ExtractedFrame) => {
      scene.prepareTemporalFrame(frame.renderables.filter((row) => row.authorVisible !== false));
      expect(scene.commitTemporalFrame().ok).toBe(true);
    };

    try {
      const initial = draw();
      expect(frameFacts(initial)).toEqual(frameFacts(drawableOracle()));
      expect(scene.inspect().fullRebuilds).toBe(1);
      submit(initial);
      const initialRecords = scene.inspect().projectionRecords;
      const initialUntouched = rowFor(initial, 0, first.untouched);
      const initialOtherWorld = rowFor(initial, 1, second.untouched);
      expect(initialUntouched).toBeDefined();
      expect(initialOtherWorld).toBeDefined();

      requests.length = 0;
      first.world.set(first.mixed, Instances, { transforms: matrices(3, 2) }).unwrap();
      first.world.set(first.mixed, Transform, { pos: [0.25, 0, 0] }).unwrap();
      first.world.set(first.mixed, ChildOf, { parent: first.parentB }).unwrap();
      first.world.set(first.parentA, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
      first.world
        .set(first.hiddenTarget, Visibility, { state: VisibilityStateValue.hidden })
        .unwrap();
      first.world
        .spawn({
          component: RuntimeMaterialValue,
          data: {
            asset: first.materialHandle,
            parameter: 'baseColor',
            kind: 2,
            value: [0, 1, 0, 1],
          },
        })
        .unwrap();
      first.world.update(0).unwrap();

      const mixed = draw();
      const mixedOracle = oracle();
      expect(frameFacts(mixed)).toEqual(frameFacts(drawableOracle()));
      expect(rowFor(mixed, 0, first.hiddenTarget)).toBeUndefined();
      expect(rowFor(mixedOracle, 0, first.hiddenTarget)?.authorVisible).toBe(false);
      expect(requests).not.toContain('full');
      expect(scene.inspect()).toMatchObject({ fullRebuilds: 1, projectionRecords: initialRecords });
      expect(rowFor(mixed, 0, first.mixed)?.instances?.instanceCount).toBe(3);
      expect(rowFor(mixed, 0, first.sharedConsumer)?.material.baseColor).toEqual(
        new Float32Array([0, 1, 0]),
      );
      expect(rowFor(mixed, 1, second.sharedConsumer)?.material.baseColor).toEqual(
        new Float32Array([1, 0, 0]),
      );

      const unchanged = rowFor(mixed, 1, second.untouched);
      expect(unchanged?.temporal?.previousSource).toBe('last-submitted');
      expect(unchanged?.temporal?.previousTransform.world).toEqual(
        initialOtherWorld?.transform.world,
      );
      expect(rowFor(mixed, 0, first.mixed)?.temporal?.previousSource).toBe('current-seed');
      expect(rowFor(mixed, 0, first.mixed)?.temporal?.previousTransform.world).toEqual(
        rowFor(mixed, 0, first.mixed)?.transform.world,
      );
      submit(mixed);

      requests.length = 0;
      first.world.set(first.mixed, Instances, { transforms: matrices(0, 0) }).unwrap();
      first.world.update(0).unwrap();
      const zero = draw();
      expect(frameFacts(zero)).toEqual(frameFacts(drawableOracle()));
      expect(rowFor(zero, 0, first.mixed)?.instances?.instanceCount).toBe(0);
      expect(requests).not.toContain('full');
      expect(scene.inspect()).toMatchObject({ fullRebuilds: 1, projectionRecords: initialRecords });
      submit(zero);

      requests.length = 0;
      first.world.set(first.mixed, Instances, { transforms: matrices(1, -2) }).unwrap();
      first.world.update(0).unwrap();
      const one = draw();
      expect(frameFacts(one)).toEqual(frameFacts(drawableOracle()));
      expect(rowFor(one, 0, first.mixed)?.instances?.instanceCount).toBe(1);
      expect(requests).not.toContain('full');
      expect(scene.inspect()).toMatchObject({ fullRebuilds: 1, projectionRecords: initialRecords });
    } finally {
      leases[0].dispose();
      leases[1].dispose();
      scene.dispose();
      instanceCollections.dispose();
    }
  });

  it('retains slot and temporal history across World reorder and catalog refresh', () => {
    const instanceCollections = new InstanceProjectionStore();
    const first = createWorld(true);
    const second = createWorld(false);
    let worlds: readonly World[] = [first.world, second.world];
    let leases = [createRenderReadLease(first.world), createRenderReadLease(second.world)];
    let owner = { cameraOwner: 0, resourceOwner: 0 };
    let catalogEpoch = 0;
    const scene = new PersistentRenderScene({ instanceCollections });
    const requests: PersistentRenderCandidateRequest[] = [];
    const materialCaches = scene.materialSnapshotCacheStore();
    const assets = new AssetRegistry({
      materialArtifact: () => undefined,
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const build = (request: PersistentRenderCandidateRequest) => {
      requests.push(request);
      return extractFrames(worlds, owner, assets, undefined, materialCaches, {
        cull: 'none',
        retainHidden: true,
        renderables: request,
        instanceCollections,
      });
    };
    const draw = () => scene.extractComposition(worlds, owner, catalogEpoch, build, leases);
    const oracle = () =>
      extractFrames(worlds, owner, assets, undefined, undefined, {
        cull: 'none',
        retainHidden: true,
        renderables: 'full',
        instanceCollections,
      });
    const drawableOracle = () => {
      const frame = oracle();
      return {
        ...frame,
        renderables: frame.renderables.filter((row) => row.authorVisible !== false),
      };
    };
    const submit = (frame: ExtractedFrame) => {
      scene.prepareTemporalFrame(frame.renderables.filter((row) => row.authorVisible !== false));
      expect(scene.commitTemporalFrame().ok).toBe(true);
    };
    try {
      const initial = draw();
      expect(frameFacts(initial)).toEqual(frameFacts(drawableOracle()));
      submit(initial);
      const initialRecords = scene.inspect().projectionRecords;
      const initialRow = rowFor(initial, 0, first.untouched);
      expect(initialRow).toBeDefined();

      worlds = [second.world, first.world];
      const firstLease = leases[0];
      const secondLease = leases[1];
      if (firstLease === undefined || secondLease === undefined) throw new Error('missing lease');
      leases = [secondLease, firstLease];
      owner = { cameraOwner: 1, resourceOwner: 1 };
      requests.length = 0;
      const reordered = draw();
      expect(frameFacts(reordered)).toEqual(frameFacts(drawableOracle()));
      expect(scene.inspect()).toMatchObject({ fullRebuilds: 1, projectionRecords: initialRecords });
      const reorderedRow = rowFor(reordered, 1, first.untouched);
      expect(
        reorderedRow?.temporal?.previousSource,
        JSON.stringify(reorderedRow?.temporal?.reactiveReasons),
      ).toBe('last-submitted');
      expect(reorderedRow?.temporal?.previousTransform.world).toEqual(initialRow?.transform.world);
      submit(reordered);

      catalogEpoch = 1;
      requests.length = 0;
      const refreshed = draw();
      expect(frameFacts(refreshed)).toEqual(frameFacts(drawableOracle()));
      expect(requests).not.toContain('full');
      expect(requests.some((request) => typeof request === 'object')).toBe(true);
      expect(scene.inspect()).toMatchObject({ fullRebuilds: 1, projectionRecords: initialRecords });
    } finally {
      leases[0]?.dispose();
      leases[1]?.dispose();
      scene.dispose();
      instanceCollections.dispose();
    }
  });

  it('scopes parent and leaf visibility changes while preserving unrelated snapshots', () => {
    const instanceCollections = new InstanceProjectionStore();
    const first = createWorld(true);
    const lease = createRenderReadLease(first.world);
    const scene = new PersistentRenderScene({ instanceCollections });
    const assets = new AssetRegistry({
      materialArtifact: () => undefined,
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const owner = { cameraOwner: 0, resourceOwner: 0 } as const;
    const build = (request: PersistentRenderCandidateRequest) =>
      extractFrames([first.world], owner, assets, undefined, scene.materialSnapshotCacheStore(), {
        cull: 'none',
        retainHidden: true,
        renderables: request,
        instanceCollections,
      });
    const draw = () => scene.extractComposition([first.world], owner, 0, build, [lease]);

    try {
      const initial = draw();
      const unrelated = scene
        .compositionSlots()
        .find((slot) => slot.entityKey === first.sharedConsumer);
      expect(unrelated).toBeDefined();
      const unrelatedSnapshot = unrelated?.snapshot;

      first.world.set(first.parentA, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
      first.world.update(0).unwrap();
      const parentHidden = draw();
      expect(rowFor(parentHidden, 0, first.mixed)).toBeUndefined();
      expect(
        scene.compositionSlots().find((slot) => slot.entityKey === first.sharedConsumer)?.snapshot,
      ).toBe(unrelatedSnapshot);

      first.world.set(first.parentA, Visibility, { state: VisibilityStateValue.visible }).unwrap();
      first.world.update(0).unwrap();
      draw();
      first.world.set(first.mixed, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
      first.world.update(0).unwrap();
      const leafHidden = draw();
      expect(rowFor(leafHidden, 0, first.mixed)).toBeUndefined();
      expect(
        scene.compositionSlots().find((slot) => slot.entityKey === first.sharedConsumer)?.snapshot,
      ).toBe(unrelatedSnapshot);
      expect(initial.renderables.some((row) => row.entityKey === first.sharedConsumer)).toBe(true);
    } finally {
      lease.dispose();
      scene.dispose();
      instanceCollections.dispose();
    }
  });
});

it('two Renderers independently observe shared content replacement, rebinding, deletion and retry', () => {
  const fixture = createWorld(true);
  const { world, materialHandle, sharedConsumer } = fixture;
  const owner = { cameraOwner: 0, resourceOwner: 0 };
  const assets = new AssetRegistry({
    materialArtifact: () => undefined,
    findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
  } as unknown as ShaderRegistry);
  const consumers = [0, 1].map(() => {
    const instanceCollections = new InstanceProjectionStore();
    const scene = new PersistentRenderScene({ instanceCollections });
    const lease = createRenderReadLease(world);
    let fail = false;
    const build = (request: PersistentRenderCandidateRequest) => {
      if (fail) {
        fail = false;
        throw new Error('injected extraction failure');
      }
      return extractFrames([world], owner, assets, undefined, scene.materialSnapshotCacheStore(), {
        cull: 'none',
        retainHidden: true,
        renderables: request,
        instanceCollections,
      });
    };
    return {
      scene,
      lease,
      draw: () => scene.extractComposition([world], owner, 0, build, [lease]),
      fail: () => {
        fail = true;
      },
    };
  });
  const color = (frame: ExtractedFrame) =>
    Array.from(rowFor(frame, 0, sharedConsumer)?.material.baseColor ?? []);
  try {
    for (const consumer of consumers) expect(color(consumer.draw())).toEqual([1, 0, 0]);
    const content = world
      .spawn({
        component: RuntimeMaterialValue,
        data: {
          asset: materialHandle,
          parameter: 'baseColor',
          kind: 2,
          value: [0, 1, 0, 1],
        },
      })
      .unwrap();
    for (const consumer of consumers) {
      consumer.fail();
      expect(() => consumer.draw()).toThrow('injected extraction failure');
      expect(color(consumer.draw())).toEqual([0, 1, 0]);
    }
    const other = world.allocSharedRef('MaterialAsset', material({ baseColor: [0, 0, 1, 1] }));
    world.set(content, RuntimeMaterialValue, { asset: other }).unwrap();
    for (const consumer of consumers) expect(color(consumer.draw())).toEqual([1, 0, 0]);
    world
      .set(content, RuntimeMaterialValue, { asset: materialHandle, value: [0, 0, 1, 1] })
      .unwrap();
    for (const consumer of consumers) expect(color(consumer.draw())).toEqual([0, 0, 1]);
    world.despawn(content).unwrap();
    for (const consumer of consumers) expect(color(consumer.draw())).toEqual([1, 0, 0]);
  } finally {
    for (const consumer of consumers) {
      consumer.lease.dispose();
      consumer.scene.dispose();
    }
  }
});
