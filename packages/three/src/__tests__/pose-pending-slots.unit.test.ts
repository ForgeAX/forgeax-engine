import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { GlobalTransform, Name } from '@forgeax/engine-scene';
import { SynchronousTransform } from '@forgeax/engine-scene/internal';
import {
  Group,
  NoToneMapping,
  type Object3D,
  PerspectiveCamera,
  Scene,
} from 'three/src/Three.Core.js';
import { expect, it, vi } from 'vitest';
import { cameraData } from '../camera';
import { SourcePosePage } from '../pose';
import { SceneProjection } from '../scene';
import { SceneChanges, setThreeSceneTracking } from '../source-changes';
import { enableThreeSourceTracking, ownedCollection } from '../source-collections';
import { resolveSourceWorldPose } from '../source-world-pose';

function ownMatrixStorage(...objects: Object3D[]): void {
  const stop = enableThreeSourceTracking();
  try {
    for (const object of objects) {
      object.matrix.elements = ownedCollection(object.matrix.elements);
      object.matrixWorld.elements = ownedCollection(object.matrixWorld.elements);
      object.children = ownedCollection(object.children);
    }
  } finally {
    stop();
  }
}

it('invalidates each source edit while sharing one pending membership address per source', () => {
  const scene = new Scene();
  const first = new Group();
  const other = new Group();
  scene.add(first, other);
  ownMatrixStorage(scene, first, other);
  const changes = new SceneChanges(scene, [], 1, undefined, true);
  const page = new SourcePosePage();
  changes.index(scene, () => true);
  page.takeEdits(changes);
  page.release(3);

  const queue = changes.pose;
  const addresses: unknown = Reflect.get(queue, 'addresses');
  const gets = addresses instanceof WeakMap ? vi.spyOn(addresses, 'get') : undefined;
  // On the preceding revision every observed edit hashes into the pending Set.
  const sets = queue instanceof Set ? vi.spyOn(queue, 'add') : undefined;
  const invalidations = vi.spyOn(SynchronousTransform.prototype, 'invalidateLocal');
  try {
    expect(resolveSourceWorldPose(scene)).toBe(true);
    for (let x = 1; x <= 512; x++) {
      first.position.x = x;
      expect(resolveSourceWorldPose(first)).toBe(true);
      expect(first.matrixWorld.elements[12]).toBe(x);
    }
    other.position.x = 1;
    expect([...queue]).toEqual([first, other]);
    expect(invalidations).toHaveBeenCalledTimes(513);
    expect((gets?.mock.calls.length ?? 0) + (sets?.mock.calls.length ?? 0)).toBe(2);
  } finally {
    gets?.mockRestore();
    sets?.mockRestore();
    invalidations.mockRestore();
    page.takeEdits(changes);
    page.release(3);
    changes.dispose();
  }
});

it('keeps source edits made by nested tracked projections and reflects world poses immediately', () => {
  const scene = new Scene();
  const parent = new Group();
  const child = new Group();
  const camera = new PerspectiveCamera();
  child.position.x = 3;
  parent.add(child);
  scene.add(parent);
  ownMatrixStorage(scene, parent, child, camera);
  setThreeSceneTracking(scene, true);
  const leftAssets = new AssetRegistry();
  const rightAssets = new AssetRegistry();
  let nested: (() => void) | undefined;
  const right = new SceneProjection(rightAssets);
  const left = new SceneProjection(leftAssets, undefined, undefined, {
    world: new World({ assets: leftAssets }),
    validateSource: (node) => {
      if (node !== parent || !nested) return;
      const observe = nested;
      nested = undefined;
      observe();
    },
  });
  const sync = (projection: SceneProjection) =>
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
      ecsPoses: true,
      updateMatrices: true,
      depth: true,
      stencil: false,
      sortObjects: true,
      opaque: true,
      transparent: true,
    });
  const worldX = (projection: SceneProjection) => {
    const entity = projection.entityFor(child);
    if (entity === undefined) throw new Error('Missing projected child');
    return projection.world.get(entity, GlobalTransform).unwrap().world[12];
  };
  try {
    for (const projection of [left, right]) {
      sync(projection);
      sync(projection);
      expect(projection.sourceWork()).toMatchObject({ mode: 'tracked', poseAuthority: 'ecs' });
    }
    // Trigger a native-observation callback inside left while right consumes independently.
    const leftParent = left.entityFor(parent);
    if (leftParent === undefined) throw new Error('Missing projected parent');
    for (let step = 1; step <= 4; step++) {
      parent.position.x = step;
      nested = () => {
        parent.position.x = step + 0.25;
        expect(resolveSourceWorldPose(parent)).toBe(true);
        expect(resolveSourceWorldPose(child)).toBe(true);
        expect(child.matrixWorld.elements[12]).toBe(step + 3.25);
        sync(right);
        expect(worldX(right)).toBe(step + 3.25);
        parent.position.x = step + 0.5;
        expect(resolveSourceWorldPose(parent)).toBe(true);
        expect(resolveSourceWorldPose(child)).toBe(true);
        expect(child.matrixWorld.elements[12]).toBe(step + 3.5);
      };
      left.world.set(leftParent, Name, { value: `native-${step}` }).unwrap();
      sync(left);
      expect(nested).toBeUndefined();
      sync(left);
      sync(right);
      expect(worldX(left)).toBe(step + 3.5);
      expect(worldX(right)).toBe(step + 3.5);
    }
    const former = left.entityFor(child);
    parent.remove(child);
    sync(left);
    sync(right);
    expect(left.entityFor(child)).toBeUndefined();
    expect(right.entityFor(child)).toBeUndefined();
    child.position.x = 13;
    parent.add(child);
    sync(left);
    sync(right);
    expect(left.entityFor(child)).not.toBe(former);
    expect(worldX(left)).toBe(17.5);
    expect(worldX(right)).toBe(17.5);
  } finally {
    left.dispose();
    right.dispose();
    leftAssets.dispose();
    rightAssets.dispose();
  }
});

it('drains insertion order across active cursors, removal and reinsertion', () => {
  const scene = new Scene();
  const changes = new SceneChanges(scene, [], 1, undefined, true);
  const pending = changes.pose;
  const a = new Group();
  const b = new Group();
  const c = new Group();
  pending.add(a);
  pending.add(b);
  pending.add(c);
  const first = pending[Symbol.iterator]();
  const second = pending[Symbol.iterator]();
  try {
    expect(first.next().value).toBe(a);
    expect(second.next().value).toBe(a);
    pending.delete(b);
    pending.add(b);
    pending.delete(a);
    pending.add(a);
    for (const cursor of [first, second]) {
      expect(cursor.next().value).toBe(c);
      expect(cursor.next().value).toBe(b);
      expect(cursor.next().value).toBe(a);
      expect(cursor.next().done).toBe(true);
    }
  } finally {
    first.return?.();
    second.return?.();
    changes.dispose();
  }
});

it('releases retained source rows and keeps reusable address hints weak under churn', () => {
  const changes = new SceneChanges(new Scene(), [], 1, undefined, true);
  const pending = changes.pose;
  const page = new SourcePosePage();
  const first = new Group();
  const tail = new Group();
  pending.add(first);
  const churn = Array.from({ length: 1_024 }, () => new Group());
  for (const source of churn) pending.add(source);
  pending.add(tail);
  for (const source of churn) expect(pending.delete(source)).toBe(true);
  expect([...pending]).toEqual([first, tail]);
  expect(page.takeEdits(changes)).toBe(pending);
  changes.pose.add(tail);
  expect([...changes.pose]).toEqual([tail]);
  page.release(2);
  expect([...pending]).toEqual([]);
  expect(pending.has(first)).toBe(false);
  expect(pending.has(tail)).toBe(false);
  expect(Reflect.get(pending, 'addresses')).toBeInstanceOf(WeakMap);
  const rows: unknown = Reflect.get(pending, 'rows');
  expect(Array.isArray(rows)).toBe(true);
  if (!Array.isArray(rows)) throw new Error('Missing reusable storage');
  expect(rows.length).toBeLessThanOrEqual(128);
  expect(rows.every((source) => source === undefined)).toBe(true);
  expect(page.takeEdits(changes)).not.toBe(pending);
  expect(changes.pose).toBe(pending);
  page.release(2);
  changes.dispose();
});
