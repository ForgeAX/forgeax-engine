import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { type InstanceCollectionSnapshot, InstanceProjectionStore } from '../instances';
import { MaterialResource } from '../material-resource';
import {
  defaultMaterialSnapshot,
  type MaterialSnapshot,
  type RenderableSnapshot,
} from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

function projected<T>(value: T): Exclude<T, Error> {
  if (value instanceof Error) throw value;
  return value as Exclude<T, Error>;
}

const material = new MaterialResource(defaultMaterialSnapshot());

function world(translationX: number): Float32Array {
  const result = new Float32Array(16);
  result[0] = 1;
  result[5] = 1;
  result[10] = 1;
  result[15] = 1;
  result[12] = translationX;
  return result;
}

function matrices(count: number, translationX: number): Float32Array {
  const result = new Float32Array(count * 16);
  for (let index = 0; index < count; index += 1) {
    result.set(world(translationX + index), index * 16);
  }
  return result;
}

function snapshot(
  entityKey: number,
  translationX: number,
  collection?: InstanceCollectionSnapshot,
): RenderableSnapshot {
  const instances =
    collection === undefined
      ? undefined
      : {
          ...collection,
          instanceCount: collection.count,
          cacheKey: entityKey,
          archVersion: 0,
        };
  return {
    assetHandle: 1,
    transform: { world: world(translationX) },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    ...(instances === undefined ? {} : { instances }),
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

function submit(scene: RenderScene, entityKey: number): void {
  const capture = scene.captureSubmission([{ worldId: 0, entityKey }]);
  scene.commitSubmission(capture);
}

describe('RenderScene temporal retry boundary', () => {
  it('owns visibility captures across hidden submissions, slot reuse and reset', () => {
    const scene = new RenderScene();
    scene.setTemporalTracking(true);
    const initial = snapshot(7, 1);
    scene.apply([updateSnapshot(initial)]);
    const first = scene.slot(0, 7);
    if (first === undefined) throw new Error('missing first slot');
    const visible = scene.captureSubmission([initial, initial]);
    scene.commitSubmission(visible);
    expect(scene.wasLastSubmittedVisible(first.slot, first.generation)).toBe(true);
    const hidden = scene.captureSubmission([]);
    expect(scene.wasLastSubmittedVisible(first.slot, first.generation)).toBe(true);
    scene.commitSubmission(hidden);
    expect(scene.temporalSnapshotBySlot(first.slot)?.reactiveReasons).toEqual(['reentered']);
    // Captures retain their original membership when a later submission commits.
    scene.commitSubmission(visible);
    expect(scene.wasLastSubmittedVisible(first.slot, first.generation)).toBe(true);
    scene.apply([{ kind: 'remove', worldId: 0, entityKey: 7 }, updateSnapshot(snapshot(8, 2))]);
    const reused = scene.slot(0, 8);
    if (reused === undefined) throw new Error('missing reused slot');
    expect(reused.slot).toBe(first.slot);
    expect(reused.generation).not.toBe(first.generation);
    expect(scene.wasLastSubmittedVisible(reused.slot, reused.generation)).toBe(false);
    expect(() => scene.commitSubmission(visible)).toThrow(RangeError);
    submit(scene, 8);
    expect(scene.wasLastSubmittedVisible(first.slot, first.generation)).toBe(false);
    expect(scene.wasLastSubmittedVisible(reused.slot, reused.generation)).toBe(true);
    scene.reset([snapshot(8, 2)]);
    expect(scene.wasLastSubmittedVisible(reused.slot, reused.generation)).toBe(false);
  });

  it('rejects replaced geometry locally while a static background keeps its submitted history', () => {
    const scene = new RenderScene();
    scene.setTemporalTracking(true);
    const background = snapshot(7, 1);
    const changing = snapshot(8, 2);
    scene.apply([updateSnapshot(background), updateSnapshot(changing)]);
    const visible = [
      { worldId: 0, entityKey: 7 },
      { worldId: 0, entityKey: 8 },
    ];
    scene.commitSubmission(scene.captureSubmission(visible));
    for (let revision = 0; revision < 256; revision++) {
      scene.apply([updateSnapshot({ ...changing, assetHandle: revision + 2 })]);
      expect(scene.temporalSnapshotBySlot(0)).toMatchObject({
        motionValid: true,
        reactive: false,
        previousSource: 'last-submitted',
      });
      expect(scene.temporalSnapshotBySlot(1)).toMatchObject({
        motionValid: false,
        reactive: true,
        reactiveReasons: ['geometry-revision'],
      });
      scene.commitSubmission(scene.captureSubmission(visible));
    }
  });
  it.each([
    ['displacementTexture', 1, false, true],
    ['baseColorTexture', 1, false, false],
    ['displacementTexture', 0, false, false],
    ['displacementTexture', 1, true, true],
  ] as const)('qualifies mutable %s scale %s video %s geometry evidence', (field, scale, video, reactive) => {
    const scene = new RenderScene();
    scene.setTemporalTracking(true);
    const initial = snapshot(7, 1);
    const dynamicMaterial = new MaterialResource({
      ...defaultMaterialSnapshot(),
      ...(video
        ? { videoTextureFields: new Set([field]) }
        : {
            textureSources: new Map([
              [
                field,
                {
                  kind: 'render-texture-source' as const,
                  source: 'canvas' as const,
                  owner: 'temporal-retry',
                  id: 1,
                },
              ],
            ]),
          }),
      paramSnapshot: { displacementScale: scale },
    } as MaterialSnapshot);
    const source = { ...initial, material: dynamicMaterial, materials: [dynamicMaterial] };
    scene.apply([updateSnapshot(source)]);
    submit(scene, 7);
    // The source/material identities stay stable when callers write texture
    // content. A retained matrix alone proves no prior displaced geometry.
    scene.apply([{ kind: 'update', worldId: 0, entityKey: 7, world: world(9) }]);
    const temporal = scene.temporalSnapshotBySlot(0);
    expect(temporal?.motionValid).toBe(!reactive);
    expect(temporal?.reactiveReasons).toEqual(reactive ? ['displacement-source'] : []);
  });

  it('keeps the last committed root transform across a failed root-only frame and retry', () => {
    const scene = new RenderScene();
    scene.setTemporalTracking(true);
    scene.apply([updateSnapshot(snapshot(7, 1))]);
    submit(scene, 7);

    scene.apply([{ kind: 'update', worldId: 0, entityKey: 7, world: world(9) }]);
    const duringFailure = scene.temporalSnapshotBySlot(0);
    expect(duringFailure?.previousSource).toBe('last-submitted');
    expect(duringFailure?.previousTransform.world[12]).toBe(1);

    scene.apply([{ kind: 'update', worldId: 0, entityKey: 7, world: world(9) }]);
    submit(scene, 7);
    const afterRetry = scene.temporalSnapshotBySlot(0);
    expect(afterRetry?.previousSource).toBe('last-submitted');
    expect(afterRetry?.previousTransform.world[12]).toBe(9);
  });

  it('keeps the submitted pose through several skipped frames of distinct moves', () => {
    const scene = new RenderScene();
    scene.setTemporalTracking(true);
    scene.apply([updateSnapshot(snapshot(7, 1)), updateSnapshot(snapshot(8, 4))]);
    submit(scene, 7);
    for (const x of [2, 3, 5]) {
      scene.apply([{ kind: 'update', worldId: 0, entityKey: 7, world: world(x) }]);
      // Never submitted: the history keeps the first pre-change record only.
      expect(scene.temporalSnapshotBySlot(0)?.previousTransform.world[12]).toBe(1);
      expect(scene.lastSubmittedSlotByIndex(1)).toBe(scene.slotAt(1));
    }
    submit(scene, 7);
    expect(scene.temporalSnapshotBySlot(0)?.previousTransform.world[12]).toBe(5);
  });

  it('keeps last committed root and Instances data across a failed mixed frame and retry', () => {
    const instanceCollections = new InstanceProjectionStore();
    const source = new World();
    const initialInstances = projected(instanceCollections.project(source, 7, matrices(2, 1)));
    instanceCollections.accept(source, 7, initialInstances);
    const nextInstances = projected(instanceCollections.project(source, 7, matrices(3, 9)));
    const scene = new RenderScene();
    scene.setTemporalTracking(true);
    try {
      const initial = snapshot(7, 1, initialInstances);
      const next = snapshot(7, 9, nextInstances);
      scene.apply([updateSnapshot(initial)]);
      submit(scene, 7);

      scene.apply([
        updateInstances(next),
        { kind: 'update', worldId: 0, entityKey: 7, world: next.transform.world },
      ]);
      const duringFailure = scene.temporalSnapshotBySlot(0);
      expect(duringFailure?.previousSource).toBe('last-submitted');
      expect(duringFailure?.previousTransform.world[12]).toBe(1);
      expect(duringFailure?.previousInstances?.instanceCount).toBe(2);
      expect(duringFailure?.previousInstances?.transforms[12]).toBe(1);

      scene.apply([
        updateInstances(next),
        { kind: 'update', worldId: 0, entityKey: 7, world: next.transform.world },
      ]);
      submit(scene, 7);
      const afterRetry = scene.temporalSnapshotBySlot(0);
      expect(afterRetry?.previousSource).toBe('last-submitted');
      expect(afterRetry?.previousTransform.world[12]).toBe(9);
      expect(afterRetry?.previousInstances?.instanceCount).toBe(3);
      expect(afterRetry?.previousInstances?.transforms[12]).toBe(9);
    } finally {
      instanceCollections.dispose();
    }
  });

  it('keeps instance motion valid when stable generations reorder', () => {
    const instanceCollections = new InstanceProjectionStore();
    const source = new World();
    const initialInstances = projected(instanceCollections.project(source, 7, matrices(2, 1)));
    instanceCollections.accept(source, 7, initialInstances);
    // Exercise the temporal consumer's identity remapping directly. World
    // authoring uses ordinal identity; this consumer also accepts reordered projections.
    const reorderedInstances = {
      ...projected(instanceCollections.project(source, 7, matrices(2, 9))),
      generations: new Uint32Array([
        initialInstances.generations[1] ?? 0,
        initialInstances.generations[0] ?? 0,
      ]),
    };
    const scene = new RenderScene();
    scene.setTemporalTracking(true);
    try {
      scene.apply([updateSnapshot(snapshot(7, 1, initialInstances))]);
      submit(scene, 7);
      scene.apply([updateInstances(snapshot(7, 1, reorderedInstances))]);

      const temporal = scene.temporalSnapshotBySlot(0);
      expect(temporal?.motionValid).toBe(true);
      expect(temporal?.previousInstances?.generations).toEqual(initialInstances.generations);
      expect(temporal?.previousInstances?.transforms).toEqual(initialInstances.transforms);
    } finally {
      instanceCollections.dispose();
    }
  });
});

it('captures a roster-covering submission without visiting its rows, at any scene size', () => {
  for (const count of [1000, 10000]) {
    const roster = new RenderScene();
    const listed = new RenderScene();
    for (const scene of [roster, listed]) {
      scene.setTemporalTracking(true);
      scene.apply(Array.from({ length: count }, (_, key) => updateSnapshot(snapshot(key, key))));
    }
    let visits = 0;
    const rows = {
      *[Symbol.iterator]() {
        for (let key = 0; key < count; key++) {
          visits++;
          yield { worldId: 0, entityKey: key };
        }
      },
    };
    roster.commitSubmission(roster.captureSubmission(rows, roster.slotsSnapshot()));
    expect(visits).toBe(0);
    listed.commitSubmission(listed.captureSubmission(rows));
    expect(visits).toBe(count);
    for (const slot of [0, count >> 1, count - 1]) {
      const record = roster.slotAt(slot);
      if (record === undefined) throw new Error('missing slot');
      expect(roster.wasLastSubmittedVisible(slot, record.generation)).toBe(true);
      expect(roster.temporalSnapshotBySlot(slot)).toEqual(listed.temporalSnapshotBySlot(slot));
    }
    expect(roster.wasLastSubmittedVisible(count, 1)).toBe(false);
  }
});
