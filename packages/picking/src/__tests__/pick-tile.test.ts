import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { encodeTileBits } from '@forgeax/engine-graphics-extras';
import { tilemapGeometry } from '@forgeax/engine-render';
import { Tilemap } from '@forgeax/engine-render/authoring';
import { ChildOf, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { assert, expect, it } from 'vitest';
import { pickTile } from '../pick-tile';

function fixture() {
  const assets = new AssetRegistry(),
    world = new World({ assets });
  const atlas = assets
    .create({
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      data: new Uint8Array([255, 255, 255, 255]),
    })
    .unwrap();
  const tileset = assets
    .create({
      kind: 'tileset',
      atlases: [atlas],
      tileWidth: 1,
      tileHeight: 1,
      columns: 1,
      rows: 1,
      regions: [{ x: 0, y: 0, width: 1, height: 1 }],
      tiles: [{ regionIndex: 0 }],
    })
    .unwrap();
  const map = world
    .spawn(
      { component: Transform, data: {} },
      { component: Tilemap, data: { cols: 2, rows: 2, tileset, tiles: [1, 0, 0, 1] } },
    )
    .unwrap();
  return { assets, world, tileset, map };
}
it('queries accepted cells directly and strips Tiled flip bits', () => {
  const { world, map } = fixture();
  world
    .set(map, Tilemap, { tiles: [encodeTileBits(1, true, true, true, false), 0, 0, 1] })
    .unwrap();
  expect(pickTile(world, map, 0.5, 0.5).unwrap()).toEqual({
    tilemapEntity: map,
    cellX: 0,
    cellY: 0,
    tileId: 1,
  });
  for (const [x, y] of [
    [1.5, 0.5],
    [-1, 0],
    [2, 2],
    [NaN, 0],
  ] as const)
    expect(pickTile(world, map, x, y).unwrap()).toBeNull();
});
it('uses propagated parent transforms including rotation and nonuniform scale', () => {
  const { world, map } = fixture();
  const parent = world
    .spawn({
      component: Transform,
      data: { pos: [10, 20, 0], quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 3, 1] },
    })
    .unwrap();
  world.addComponent(map, { component: ChildOf, data: { parent } }).unwrap();
  world.set(map, Tilemap, { tiles: [0, 1, 0, 0] }).unwrap();
  propagateTransforms(world).unwrap();
  expect(pickTile(world, map, 8.5, 23).unwrap()).toEqual({
    tilemapEntity: map,
    cellX: 1,
    cellY: 0,
    tileId: 1,
  });
});
it('keeps independent layers as independent ordinary entities', () => {
  const { world, map, tileset } = fixture();
  const other = world
    .spawn(
      { component: Transform, data: {} },
      { component: Tilemap, data: { tileset, cols: 1, rows: 1, tiles: [0], layerOrder: 7 } },
    )
    .unwrap();
  expect(pickTile(world, map, 0.5, 0.5).unwrap()?.tileId).toBe(1);
  expect(pickTile(world, other, 0.5, 0.5).unwrap()).toBeNull();
});
it('returns structured missing/dead errors and supports a repaired row', () => {
  const { world, map, tileset } = fixture();
  const entity = world.spawn({ component: Transform, data: {} }).unwrap();
  expect(pickTile(world, entity, 0, 0).ok).toBe(false);
  const missing = pickTile(world, entity, 0, 0);
  if (!missing.ok) expect(missing.error.code).toBe('tilemap-component-missing');
  world
    .addComponent(entity, { component: Tilemap, data: { tileset, cols: 1, rows: 1, tiles: [1] } })
    .unwrap();
  expect(pickTile(world, entity, 0.5, 0.5).unwrap()?.tileId).toBe(1);
  world.despawn(map).unwrap();
  const stale = pickTile(world, map, 0, 0);
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.error.code).toBe('tilemap-not-found');
});
it('query geometry follows current Tileset shape without changing cell bindings', () => {
  const { assets, world, map, tileset } = fixture();
  const before = tilemapGeometry(world, map);
  assert(before?.aabb);
  assets.update(tileset, { tiles: [{ regionIndex: 0, widthCells: 3 }] }).unwrap();
  const after = tilemapGeometry(world, map);
  assert(after?.aabb);
  expect(after.aabb[0]).toBeLessThan(before.aabb[0] ?? Infinity);
  expect(world.get(map, Tilemap).unwrap().tileset).toBe(tileset);
  expect(pickTile(world, map, 0.5, 0.5).unwrap()?.tileId).toBe(1);
});
it('retains deterministic singular affine fallback', () => {
  const { world, map } = fixture();
  world.set(map, Transform, { scale: [0, 0, 0] }).unwrap();
  propagateTransforms(world).unwrap();
  expect(pickTile(world, map, 0.5, 0.5).unwrap()?.tileId).toBe(1);
});
