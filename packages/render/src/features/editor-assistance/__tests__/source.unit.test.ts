import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { extractEditorAssistance } from '../source';
import { editorAssistance, readEditorAssistance } from '../state';

it('does no query, installs no state and produces no frame while disabled', () => {
  const world = new World();
  const query = vi.spyOn(world, 'query');
  expect(extractEditorAssistance({ world, frameNumber: 1, views: [] })).toBeUndefined();
  expect(readEditorAssistance(world)).toBeUndefined();
  expect(query).not.toHaveBeenCalled();
});

it('captures editor selection independently of authored components and preserves held input', () => {
  const world = new World({ assets: new AssetRegistry() });
  const parent = world.spawn({ component: Transform, data: {} }).unwrap();
  const child = world
    .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
    .unwrap();
  const state = editorAssistance(world);
  state.configure({ enabled: true }).unwrap();
  state.select([parent]).unwrap();
  const captured = extractEditorAssistance({ world, frameNumber: 1, views: [] });
  expect(new Set(captured?.outline?.entities)).toEqual(new Set([parent, child]));
  state.select([]).unwrap();
  expect(extractEditorAssistance({ world, frameNumber: 2, views: [] })?.outline).toBeUndefined();
  expect(captured?.outline?.entities).toHaveLength(2);
  expect(
    world
      .componentsOf(parent)
      .unwrap()
      .some((component) => component.name === 'Outline'),
  ).toBe(false);
});

it('rejects stale full entity handles and never selects a reused slot', () => {
  const world = new World({ assets: new AssetRegistry() });
  const first = world.spawn().unwrap();
  const state = editorAssistance(world);
  state.configure({ enabled: true }).unwrap();
  state.select([first]).unwrap();
  world.despawn(first).unwrap();
  const replacement = world.spawn().unwrap();
  expect(replacement).not.toBe(first);
  expect(state.select([first]).ok).toBe(false);
  const captured = extractEditorAssistance({ world, frameNumber: 1, views: [] });
  expect(captured?.outline).toBeUndefined();
  expect(world.componentsOf(replacement).ok).toBe(true);
});

it('captures bounded presentation geometry by value and releases it with its owner', () => {
  const world = new World({ assets: new AssetRegistry() });
  const state = editorAssistance(world);
  state.configure({ enabled: true }).unwrap();
  const owner = {},
    start: [number, number, number] = [0, 0, 0];
  state
    .contribute(owner, [
      { kind: 'line', start, end: [1, 0, 0], color: [1, 0, 0, 1], depth: 'always' },
    ])
    .unwrap();
  start[0] = 99;
  const held = state.snapshot();
  expect(held?.primitives[0]).toMatchObject({ start: [0, 0, 0] });
  state.release(owner);
  expect(state.snapshot()?.primitives).toEqual([]);
  expect(held?.primitives).toHaveLength(1);
  state.clear();
  expect(state.snapshot()).toBeUndefined();
});

it('captures fixed mesh assets locally and publishes version references across realms', () => {
  const assets = new AssetRegistry(),
    world = new World({ assets }),
    state = editorAssistance(world),
    owner = {};
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  // An unrelated later asset revision must not be mistaken for this fixed mesh version.
  const other = assets.create(createBoxGeometry(2, 2, 2).unwrap()).unwrap();
  state.configure({ enabled: true }).unwrap();
  state
    .contribute(owner, [
      {
        kind: 'mesh',
        mesh,
        transform: Array.from(mat4.identity(mat4.create())),
        color: [1, 0, 0, 1],
        depth: 'always',
      },
    ])
    .unwrap();
  assets.release(mesh).unwrap();
  expect(state.snapshot()?.meshes[0]?.value).toBeUndefined();
  const local = extractEditorAssistance({ world, frameNumber: 1, views: [] });
  expect(local?.meshes[0]?.value?.kind).toBe('mesh');
  expect(local?.primitives[0]?.meshRevision).toBe(local?.meshes[0]?.revision);
  const versions: unknown[] = [];
  const remote = extractEditorAssistance({
    world,
    frameNumber: 1,
    views: [],
    referenceAssetVersion: (version) => versions.push(version),
  });
  expect(remote?.meshes[0]).toEqual({ handle: Number(mesh), revision: local?.meshes[0]?.revision });
  expect(versions).toHaveLength(1);
  state.release(owner);
  expect(runtimeAssets(assets).resolveAsset(mesh).ok).toBe(false);
  expect(local?.meshes[0]?.value?.attributes.position).toBeInstanceOf(Float32Array);
  assets.release(other).unwrap();
  assets.dispose();
});
