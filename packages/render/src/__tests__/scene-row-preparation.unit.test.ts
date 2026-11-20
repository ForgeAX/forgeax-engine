import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import type { Asset, MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { worldRenderResources } from '../publication/resource-scope';
import type { RenderableSnapshot } from '../render-system-extract';
import { MeshFrame } from '../scene/mesh-frame';
import { RenderScene } from '../scene/render-scene-view';
import { SceneRows } from '../scene/scene-rows';
import { collectWeakOwners } from './weak-owner-collection-fixture';

function snapshot(entityKey: number, x = 0): RenderableSnapshot {
  const world = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1);
  return { entityKey, transform: { world } } as RenderableSnapshot;
}

function preparedGeometryFixture() {
  const assets = new AssetRegistry();
  const source = worldRenderResources(new World({ assets }));
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const revision = source.assetRevision(mesh);
  assert(revision !== undefined);
  const geometry = new MeshFrame()
    .with(mesh, source.resolveAsset<MeshAsset>(mesh).unwrap(), [], {
      identity: source.identity,
      revision,
    })
    .get(mesh);
  assert(geometry);
  const rows = new SceneRows(source);
  const task = rows.prepareRow({ ...snapshot(1), assetHandle: mesh, shadowCaster: false });
  return { assets, source, mesh, geometry, rows, task };
}

it('consumes geometry once while keeping authored data in the issuing Scene row', () => {
  const f = preparedGeometryFixture();
  let reads = 0;
  const publication = {
    source: f.task.row,
    geometry: f.geometry,
    get snapshot() {
      reads++;
      return { ...snapshot(99), assetHandle: f.mesh + 1 };
    },
  };
  const read = vi.spyOn(f.source, 'resolveAsset');
  try {
    const delta = f.task.publish(publication);
    expect(reads).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(delta.createdSlots[0]?.entityKey).toBe(1);
    expect(delta.createdSlots[0]?.snapshot.shadowCaster).toBe(false);
    expect(f.rows.lookup(99)).toBeUndefined();
    expect(f.rows.meshFrame().get(f.mesh)).toBe(f.geometry);
  } finally {
    read.mockRestore();
    f.task.release();
    f.rows.dispose();
    f.assets.dispose();
  }
});

it.each([
  'same-revision',
  'changed-revision',
  'unqualified',
] as const)('adopts %s Mesh evidence without replacing a proven equal producer capture', (mode) => {
  const f = preparedGeometryFixture();
  try {
    f.task.publish({ source: f.task.row, geometry: f.geometry });
    const before = f.rows.meshFrame();
    if (mode === 'changed-revision')
      f.assets.update(f.mesh, { aabb: Float32Array.of(-2, -2, -2, 2, 2, 2) }).unwrap();
    const asset = f.source.resolveAsset<MeshAsset>(f.mesh).unwrap();
    f.rows.adoptMesh(f.mesh, mode === 'unqualified' ? { ...asset } : asset);
    const after = f.rows.meshFrame();
    expect(after === before).toBe(mode === 'same-revision');
    expect(after.get(f.mesh) === f.geometry).toBe(mode === 'same-revision');
    if (mode === 'changed-revision') expect(after.get(f.mesh)?.bounds?.[0]).toBe(-2);
  } finally {
    f.task.release();
    f.rows.dispose();
    f.assets.dispose();
  }
});

it.each([
  'foreign-row',
  'revision',
  'canonical',
  'namespace',
] as const)('rejects prepared geometry after %s changes without consuming the reserved identity', (change) => {
  const f = preparedGeometryFixture();
  const other = f.rows.prepareRow({ ...snapshot(2), assetHandle: f.mesh });
  const publication = { source: f.task.row, geometry: f.geometry };
  if (change === 'foreign-row') publication.source = other.row;
  if (change === 'revision')
    f.assets.update(f.mesh, { aabb: Float32Array.of(-2, -2, -2, 2, 2, 2) }).unwrap();
  if (change === 'canonical')
    f.rows.apply([
      { kind: 'update', entityKey: 3, snapshot: { ...snapshot(3), assetHandle: f.mesh } },
    ]);
  if (change === 'namespace')
    publication.geometry = { ...f.geometry, source: { identity: 'foreign', revision: 1 } };
  const before = f.rows.capture();
  const meshes = f.rows.meshFrame();
  try {
    expect(() => f.task.publish(publication)).toThrow();
    expect(f.task.isCurrent()).toBe(true);
    expect(f.rows.capture()).toBe(before);
    expect(f.rows.meshFrame()).toBe(meshes);
    expect(f.rows.lookup(1)).toBeUndefined();
  } finally {
    other.release();
    f.task.release();
    f.rows.dispose();
    f.assets.dispose();
  }
});

it.each([
  'release',
  'reset',
  'source',
] as const)('refuses prepared row publication after revision qualification causes %s reentry', (operation) => {
  const f = preparedGeometryFixture();
  const publication = { source: f.task.row, geometry: f.geometry };
  const revision = f.source.assetRevision(f.mesh);
  const changed = vi.spyOn(f.source, 'assetRevision').mockImplementationOnce(() => {
    if (operation === 'release') f.task.release();
    else if (operation === 'reset') f.rows.dispose();
    else f.rows.setSource(worldRenderResources(new World({ assets: f.assets })));
    return revision;
  });
  try {
    expect(() => f.task.publish(publication)).toThrow();
    expect(f.rows.lookup(1)).toBeUndefined();
    expect(f.rows.holdsMesh(f.mesh)).toBe(false);
  } finally {
    changed.mockRestore();
    f.task.release();
    f.rows.dispose();
    f.assets.dispose();
  }
});

it('keeps the fixed row identity responsible when wrapper observation fails', () => {
  const scene = new RenderScene();
  let reads = 0;
  const input = {
    ...snapshot(1),
    get entityKey() {
      return ++reads <= 2 ? 1 : 2;
    },
  };
  const task = scene.prepareRow(input);
  const rows = (scene as unknown as { rows: SceneRows }).rows;
  const failure = new Error('actual Scene observation failure');
  const observe = vi.spyOn(scene, 'observe').mockImplementationOnce(() => {
    throw failure;
  });
  try {
    expect(() => task.publish()).toThrow(failure);
    expect(rows.lookup(1)).toBeDefined();
    expect(() => task.release()).toThrow('cleanup responsibility');
    observe.mockRestore();
    scene.apply([{ kind: 'remove', entityKey: 1 }]);
    scene.apply([{ kind: 'update', entityKey: 1, snapshot: snapshot(1) }]);
    task.release();
    expect(rows.lookup(1)).toBeDefined();
  } finally {
    observe.mockRestore();
    scene.dispose();
    task.release();
  }
});

it('rolls back acquired content and Mesh references when the actual source reader throws before publication', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const source = worldRenderResources(world);
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const rows = new SceneRows(source);
  const before = rows.capture();
  const meshes = rows.meshFrame();
  const task = rows.prepareRow({ ...snapshot(1), assetHandle: mesh });
  const identity = task.row;
  const failure = new Error('actual Mesh reader failure');
  const read = vi.spyOn(source, 'resolveAsset').mockImplementationOnce(() => {
    throw failure;
  });
  try {
    expect(() => task.publish()).toThrow(failure);
    task.release();
    expect(rows.capture()).toBe(before);
    expect(rows.holdsMesh(mesh)).toBe(false);
    expect(rows.meshFrame()).toBe(meshes);
    expect((rows as unknown as { contents: { size: number } }).contents.size).toBe(0);
    read.mockRestore();
    const next = rows.prepareRow({ ...snapshot(2), assetHandle: mesh });
    expect(next.row.slot).toBe(identity.slot);
    expect(next.row.generation).toBeGreaterThan(identity.generation);
    next.publish();
    expect(rows.lookup(2)?.snapshot.assetHandle).toBe(mesh);
    expect(rows.holdsMesh(mesh)).toBe(true);
  } finally {
    read.mockRestore();
    task.release();
    rows.dispose();
    assets.dispose();
  }
});

it.each([
  'release',
  'reset',
] as const)('does not publish or retain Mesh refs after source-reader %s reentry', (kind) => {
  const assets = new AssetRegistry();
  const source = worldRenderResources(new World({ assets }));
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const rows = new SceneRows(source);
  const before = rows.meshFrame();
  const task = rows.prepareRow({ ...snapshot(1), assetHandle: mesh });
  const read = source.resolveAsset.bind(source) as typeof source.resolveAsset;
  const hook = vi
    .spyOn(source, 'resolveAsset')
    .mockImplementationOnce(<T extends Asset>(handle: number, revision?: number) => {
      if (kind === 'release') task.release();
      else rows.dispose();
      return read<T>(handle, revision);
    });
  try {
    expect(() => task.publish()).toThrow();
    task.release();
    expect(rows.capture().length).toBe(0);
    expect(rows.holdsMesh(mesh)).toBe(false);
    expect((rows as unknown as { contents: { size: number } }).contents.size).toBe(0);
    if (kind === 'release') expect(rows.meshFrame()).toBe(before);
    else expect(rows.meshFrame().get(mesh)).toBeUndefined();
    const next = rows.prepareRow(snapshot(2));
    expect(next.isCurrent()).toBe(true);
    task.release();
    expect(next.publish().createdSlots[0]?.entityKey).toBe(2);
  } finally {
    hook.mockRestore();
    task.release();
    rows.dispose();
    assets.dispose();
  }
});

it('keeps reserved identities and owned poses outside active rows while ordinary rows continue', () => {
  const rows = new SceneRows();
  rows.apply([{ kind: 'update', entityKey: 1, snapshot: snapshot(1) }]);
  const before = rows.capture();
  const revision = rows.revision;
  const meshes = rows.meshFrame();
  const source = snapshot(2, 7);
  const first = rows.prepareRow(source);
  const second = rows.prepareRow(snapshot(3, 11));
  const identities = [first.row, second.row];
  try {
    expect(first.row.slot).not.toBe(second.row.slot);
    expect(rows.capture()).toBe(before);
    expect(rows.revision).toBe(revision);
    expect(rows.meshFrame()).toBe(meshes);
    expect(rows.lookup(2)).toBeUndefined();
    source.transform.world[12] = 99;
    expect(first.row.snapshot.transform.world[12]).toBe(7);
    const ordinary = rows.apply([{ kind: 'update', entityKey: 4, snapshot: snapshot(4) }]);
    const ordinaryRow = ordinary.createdSlots[0];
    assert(ordinaryRow);
    expect(identities.some((row) => row.slot === ordinaryRow.slot)).toBe(false);
    const publishedSecond = second.publish().createdSlots[0];
    const publishedFirst = first.publish().createdSlots[0];
    expect(publishedSecond).toMatchObject({
      slot: identities[1]?.slot,
      generation: identities[1]?.generation,
    });
    expect(publishedFirst).toMatchObject({
      slot: identities[0]?.slot,
      generation: identities[0]?.generation,
    });
    expect(rows.lookup(2)?.snapshot.transform.world[12]).toBe(7);
    expect(rows.lookup(3)?.snapshot.transform.world[12]).toBe(11);
    expect(before.lookup(2)).toBeUndefined();
    expect(first.isCurrent()).toBe(false);
  } finally {
    second.release();
    first.release();
    rows.dispose();
  }
});

it('returns canceled addresses without a row publication and never reuses an old generation', () => {
  const rows = new SceneRows();
  rows.apply([{ kind: 'update', entityKey: 1, snapshot: snapshot(1) }]);
  const before = rows.capture();
  const first = rows.prepareRow(snapshot(2));
  const identity = first.row;
  const second = rows.prepareRow(snapshot(3));
  second.release();
  first.release();
  expect(rows.capture()).toBe(before);
  expect(() => first.row).toThrow('closed');
  expect(() => first.publish()).toThrow('not current');
  const next = rows.prepareRow(snapshot(4));
  try {
    expect(next.row.slot).toBe(identity.slot);
    expect(next.row.generation).toBeGreaterThan(identity.generation);
    const delta = next.publish();
    expect(delta.createdSlots[0]).toMatchObject({ entityKey: 4, slot: identity.slot });
    first.release();
    expect(rows.lookup(4)).toBe(delta.createdSlots[0]);
  } finally {
    next.release();
    rows.dispose();
  }
});

it('rejects competing content admission before mutating an unrelated row or the reserved identity', () => {
  const rows = new SceneRows();
  rows.apply([{ kind: 'update', entityKey: 1, snapshot: snapshot(1) }]);
  const task = rows.prepareRow(snapshot(2));
  const before = rows.capture();
  try {
    expect(() =>
      rows.apply([
        { kind: 'update', entityKey: 1, snapshot: snapshot(1, 19) },
        { kind: 'update', entityKey: 2, snapshot: snapshot(2, 23) },
      ]),
    ).toThrow('unpublished');
    expect(() => rows.reconcile([snapshot(2)])).toThrow('unpublished');
    expect(rows.capture()).toBe(before);
    expect(rows.apply([{ kind: 'remove', entityKey: 2 }]).removed).toBe(0);
    expect(task.isCurrent()).toBe(true);
  } finally {
    task.release();
    rows.dispose();
  }
});

it('invalidates old reservations on owner reset without letting their release free a new claim', () => {
  const rows = new SceneRows();
  const old = rows.prepareRow(snapshot(1));
  const identity = old.row;
  rows.dispose();
  const next = rows.prepareRow(snapshot(2));
  try {
    expect(next.row.slot).toBe(identity.slot);
    expect(old.isCurrent()).toBe(false);
    expect(() => old.publish()).toThrow('not current');
    old.release();
    expect(next.isCurrent()).toBe(true);
    expect(next.publish().createdSlots[0]?.entityKey).toBe(2);
  } finally {
    next.release();
    rows.dispose();
  }
});

it('does not retain the row owner after closing an unpublished preparation', async () => {
  const held = (() => {
    const rows = new SceneRows();
    const task = rows.prepareRow(snapshot(1));
    task.release();
    return { task, owner: new WeakRef(rows) };
  })();
  await collectWeakOwners();
  expect(held.task.isCurrent()).toBe(false);
  expect(held.owner.deref()).toBeUndefined();
});
