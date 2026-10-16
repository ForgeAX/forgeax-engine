// pick-tile.test - pickTile cell-level query (worldX/Y -> tileId)
// (feat-20260608 M0 baseline rebuild).
//
// Anchors: plan-tasks m0-t7 / m0-t8; plan-strategy §D-5 / §M0 targetFiles
// (pickTile); feat-20260604 baseline; charter P3 explicit failure.

import { World } from '@forgeax/engine-ecs';
import { TileLayer, Tilemap } from '@forgeax/engine-render/authoring';
import { ChildOf, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { pickTile } from '../pick-tile';

function makeFixture(opts: {
  cols: number;
  rows: number;
  layers: ReadonlyArray<{ layerOrder: number; tiles: readonly number[] }>;
}) {
  const world = new World();
  const tilemap = world
    .spawn(
      { component: Tilemap, data: { cols: opts.cols, rows: opts.rows, tileset: 'test/tileset' } },
      { component: Transform, data: {} },
    )
    .unwrap();
  const layerEntities = opts.layers.map((spec) => {
    const tilesArr = new Uint32Array(opts.cols * opts.rows);
    for (let i = 0; i < spec.tiles.length; i++) tilesArr[i] = spec.tiles[i] ?? 0;
    return world
      .spawn(
        { component: TileLayer, data: { tiles: tilesArr, layerOrder: spec.layerOrder } },
        { component: ChildOf, data: { parent: tilemap } },
      )
      .unwrap();
  });
  return { world, tilemap, layerEntities };
}

describe('pickTile (M0 baseline)', () => {
  it('hits the cell containing worldX/Y on a single-layer tilemap', () => {
    const { world, tilemap } = makeFixture({
      cols: 4,
      rows: 4,
      layers: [{ layerOrder: 0, tiles: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }],
    });
    const r = pickTile(world, tilemap, 1.5, 1.5);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toBeNull();
      if (r.value !== null) {
        expect(r.value.cellX).toBe(1);
        expect(r.value.cellY).toBe(1);
        expect(r.value.tileId).toBe(1);
      }
    }
  });

  it('returns Result.ok(null) when worldX/Y is out of bounds', () => {
    const { world, tilemap } = makeFixture({
      cols: 2,
      rows: 2,
      layers: [{ layerOrder: 0, tiles: [1, 0, 0, 0] }],
    });
    const r = pickTile(world, tilemap, 100, 100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('returns Result.ok(null) when no non-zero tile occupies the cell', () => {
    const { world, tilemap } = makeFixture({
      cols: 2,
      rows: 2,
      layers: [{ layerOrder: 0, tiles: [1, 0, 0, 0] }],
    });
    const r = pickTile(world, tilemap, 1.5, 1.5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('walks layers in layerOrder-descending order (high layer wins)', () => {
    // layer 0: cell (0,0) has tile 1
    // layer 5: cell (0,0) has tile 7
    const { world, tilemap } = makeFixture({
      cols: 2,
      rows: 2,
      layers: [
        { layerOrder: 0, tiles: [1, 0, 0, 0] },
        { layerOrder: 5, tiles: [7, 0, 0, 0] },
      ],
    });
    const r = pickTile(world, tilemap, 0.5, 0.5);
    expect(r.ok).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.tileId).toBe(7);
    } else {
      expect.fail('expected a hit');
    }
  });

  it('uses the propagated inverse affine transform for translated rotated scaled maps', () => {
    const world = new World();
    const tilemap = world
      .spawn(
        {
          component: Tilemap,
          data: { cols: 3, rows: 2, tileSize: [1, 1], tileset: 'test/tileset' },
        },
        {
          component: Transform,
          data: {
            pos: [10, 20, 0],
            // +90 degrees around Z: local cell (1.5, 0.5) maps to world (8.5, 23).
            quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
            scale: [2, 3, 1],
          },
        },
      )
      .unwrap();
    const lowerLayer = world
      .spawn(
        {
          component: TileLayer,
          data: { tiles: new Uint32Array([0, 3, 0, 0, 0, 0]), layerOrder: 0 },
        },
        { component: ChildOf, data: { parent: tilemap } },
      )
      .unwrap();
    const upperLayer = world
      .spawn(
        {
          component: TileLayer,
          data: { tiles: new Uint32Array([0, 9, 0, 0, 0, 0]), layerOrder: 7 },
        },
        { component: ChildOf, data: { parent: tilemap } },
      )
      .unwrap();

    propagateTransforms(world).unwrap();
    const r = pickTile(world, tilemap, 8.5, 23);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ layerEntity: upperLayer, cellX: 1, cellY: 0, tileId: 9 });
    }
    expect(lowerLayer).not.toBe(upperLayer);
  });

  it('falls through to lower layer when higher layer has 0 at the cell', () => {
    const { world, tilemap } = makeFixture({
      cols: 2,
      rows: 2,
      layers: [
        { layerOrder: 0, tiles: [3, 0, 0, 0] },
        { layerOrder: 5, tiles: [0, 0, 0, 0] },
      ],
    });
    const r = pickTile(world, tilemap, 0.5, 0.5);
    expect(r.ok).toBe(true);
    if (r.ok && r.value !== null) {
      expect(r.value.tileId).toBe(3);
    } else {
      expect.fail('expected a hit');
    }
  });

  it('returns tilemap-not-found for a dead handle', () => {
    const { world } = makeFixture({
      cols: 1,
      rows: 1,
      layers: [{ layerOrder: 0, tiles: [1] }],
    });
    const dead = world.spawn({ component: Transform, data: {} }).unwrap();
    world.despawn(dead).unwrap();
    const r = pickTile(world, dead, 1, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('tilemap-not-found');
  });

  it('returns Result.err when the entity does not carry Tilemap', () => {
    const { world } = makeFixture({
      cols: 1,
      rows: 1,
      layers: [{ layerOrder: 0, tiles: [1] }],
    });
    const e = world.spawn({ component: Transform, data: {} }).unwrap();
    const r = pickTile(world, e, 1, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('tilemap-component-missing');
    }
  });

  it('repairs a missing Tilemap on the same World and retries successfully', () => {
    const world = new World();
    const entity = world.spawn({ component: Transform, data: {} }).unwrap();

    const missing = pickTile(world, entity, 0.5, 0.5);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('tilemap-component-missing');

    world
      .addComponent(entity, {
        component: Tilemap,
        data: { cols: 1, rows: 1, tileSize: [1, 1], tileset: 'test/tileset' },
      })
      .unwrap();
    const layer = world
      .spawn(
        { component: TileLayer, data: { tiles: new Uint32Array([11]), layerOrder: 0 } },
        { component: ChildOf, data: { parent: entity } },
      )
      .unwrap();

    const repaired = pickTile(world, entity, 0.5, 0.5);
    expect(repaired.ok).toBe(true);
    if (repaired.ok) {
      expect(repaired.value).toEqual({ layerEntity: layer, cellX: 0, cellY: 0, tileId: 11 });
    }
  });

  it('keeps the documented mat4 singular fallback deterministic', () => {
    const { world, tilemap } = makeFixture({
      cols: 1,
      rows: 1,
      layers: [{ layerOrder: 0, tiles: [5] }],
    });
    world.set(tilemap, Transform, { pos: [7, 9, 0], scale: [0, 2, 1] }).unwrap();
    propagateTransforms(world).unwrap();

    // mat4.invert defines singular input as identity; pickTile keeps that
    // central math fallback instead of inventing another error arm.
    const first = pickTile(world, tilemap, 0.5, 0.5);
    const second = pickTile(world, tilemap, 0.5, 0.5);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value).toMatchObject({ cellX: 0, cellY: 0, tileId: 5 });
    }
  });
});
