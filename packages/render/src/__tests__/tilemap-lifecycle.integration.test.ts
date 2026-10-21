import { encodeTileBits } from '@forgeax/engine-graphics-extras';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer, Visibility } from '../components';
import { Tilemap } from '../components/tilemap';
import { tilemapFixture } from './tilemap-fixture';

it('chunks batch by atlas and per-cell sorting emits only real occupied cells', () => {
  const f = tilemapFixture({ cols: 55, rows: 56, chunkSize: 16 });
  try {
    const frame = f.draw();
    expect(frame.renderables).toHaveLength(16);
    expect(
      frame.renderables.reduce((n, row) => n + (row.generatedMesh?.indices?.length ?? 0) / 6, 0),
    ).toBe(55 * 56);
    expect([...f.world.query({ read: [MeshFilter, MeshRenderer] }).unwrap()]).toHaveLength(0);
    f.world
      .set(f.entity, Tilemap, {
        sortScope: 1,
        tiles: new Uint32Array(55 * 56).fill(0).map((_, i) => (i % 101 === 0 ? 1 : 0)),
      })
      .unwrap();
    expect(f.draw().renderables).toHaveLength(Math.ceil((55 * 56) / 101));
    f.world.set(f.entity, Tilemap, { tiles: new Uint32Array(55 * 56) }).unwrap();
    expect(f.draw().renderables).toHaveLength(0);
  } finally {
    f.dispose();
  }
});
it('multi-atlas batches share material by atlas and retain exact region UVs', () => {
  const f = tilemapFixture({ cols: 4, rows: 1, tiles: new Uint32Array([1, 2, 1, 2]) });
  try {
    const second = f.assets
      .create({
        kind: 'texture',
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        shape: { viewDimension: '2d', extent: { width: 64, height: 32 } },
        data: new Uint8Array(64 * 32 * 4).fill(128),
      })
      .unwrap();
    f.assets
      .update(f.tileset, {
        atlases: [f.atlas, second],
        atlasSizes: [
          { pixelWidth: 32, pixelHeight: 32 },
          { pixelWidth: 64, pixelHeight: 32 },
        ],
        regions: [
          { x: 0, y: 0, width: 16, height: 16 },
          { x: 32, y: 0, width: 16, height: 16, atlasIndex: 1 },
        ],
        tiles: [{ regionIndex: 0 }, { regionIndex: 1 }],
      })
      .unwrap();
    const frame = f.draw();
    expect(frame.renderables).toHaveLength(2);
    expect(new Set(frame.renderables.map((row) => row.material.snapshot.baseColorTexture))).toEqual(
      new Set([f.atlas, second]),
    );
    expect(frame.renderables.map((row) => row.generatedMesh?.indices?.length)).toEqual([12, 12]);
    f.world.set(f.entity, Tilemap, { sortScope: 1 }).unwrap();
    const cells = f.draw();
    expect(cells.renderables).toHaveLength(4);
    expect(new Set(cells.renderables.map((row) => row.material)).size).toBe(2);
    expect(cells.renderables.at(0)?.generatedMesh).toBe(cells.renderables.at(2)?.generatedMesh);
  } finally {
    f.dispose();
  }
});
it.each([
  0, 1,
])('retains overhanging geometry outside its anchor chunk with a no-overhang falsifier (sort %s)', (sortScope) => {
  const f = tilemapFixture({
    cols: 8,
    rows: 1,
    chunkSize: 4,
    sortScope,
    tiles: new Uint32Array([0, 0, 0, 0, 1, 0, 0, 0]),
  });
  try {
    f.world.set(f.entity, Tilemap, { tileSize: [16, 16] }).unwrap();
    f.world.set(f.camera, Transform, { pos: [55, 0, 5] }).unwrap();
    f.world.set(f.camera, Camera, { left: -5, right: 5, bottom: -8, top: 8 }).unwrap();
    expect(f.draw().dispatch.length).toBe(0);
    for (const [h, v, d] of [
      [false, false, false],
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ] as const) {
      f.assets
        .update(f.tileset, {
          tiles: [{ regionIndex: 0, widthCells: 2, heightCells: 2, pivotX: 0.5, pivotY: 0.5 }],
        })
        .unwrap();
      f.world
        .set(f.entity, Tilemap, {
          tiles: new Uint32Array([0, 0, 0, 0, encodeTileBits(1, h, v, d, false), 0, 0, 0]),
        })
        .unwrap();
      expect(f.draw().dispatch.length).toBe(1);
    }
    f.world.set(f.camera, Transform, { pos: [200, 0, 5] }).unwrap();
    expect(f.draw().dispatch.length).toBe(0);
    f.world.set(f.camera, Transform, { pos: [55, 0, 5] }).unwrap();
    expect(f.draw().dispatch.length).toBe(1);
  } finally {
    f.dispose();
  }
});
it('accepted source snapshots, repeated edits, hierarchy despawn and generation reuse keep one source authority', () => {
  const f = tilemapFixture();
  try {
    const parent = f.world.spawn({ component: Transform, data: { pos: [2, 0, 0] } }).unwrap();
    f.world.addComponent(f.entity, { component: ChildOf, data: { parent } }).unwrap();
    const initial = f.draw();
    expect(initial.renderables.at(0)?.transform.world[12]).toBe(2);
    const cells = f.world.get(f.entity, Tilemap).unwrap().tiles;
    cells.fill(0);
    expect(f.draw().renderables.at(0)?.generatedMesh).toBe(
      initial.renderables.at(0)?.generatedMesh,
    );
    for (let i = 0; i < 3; i++) {
      f.world.set(f.entity, Tilemap, { tiles: [1, 0, 0, 1] }).unwrap();
      expect(f.draw().renderables.at(0)?.generatedMesh?.indices).toHaveLength(12);
      f.world.set(f.entity, Tilemap, { tiles: [1, 1, 1, 1] }).unwrap();
      expect(f.draw().renderables.at(0)?.generatedMesh?.indices).toHaveLength(24);
    }
    f.world.despawn(parent).unwrap();
    expect(f.draw().renderables).toHaveLength(0);
    const next = f.world
      .spawn(
        { component: Transform, data: {} },
        { component: Tilemap, data: { tileset: f.tileset, cols: 1, rows: 1, tiles: [1] } },
      )
      .unwrap();
    expect(next).not.toBe(f.entity);
    expect(f.draw().renderables).toHaveLength(1);
    expect([...f.world.query({ read: [Transform] }).unwrap()]).toHaveLength(2);
  } finally {
    f.dispose();
  }
});

it('World-owned Tilesets remain isolated and reject a foreign handle', () => {
  const a = tilemapFixture(),
    b = tilemapFixture();
  try {
    const before = b.draw().renderables.at(0)?.generatedMesh;
    a.assets.update(a.tileset, { tiles: [{ regionIndex: 0, widthCells: 2 }] }).unwrap();
    expect(a.draw().renderables.at(0)?.localAabb?.[3]).toBe(2.5);
    expect(b.draw().renderables.at(0)?.generatedMesh).toBe(before);
    expect(b.world.set(b.entity, Tilemap, { tileset: a.tileset }).ok).toBe(false);
  } finally {
    a.dispose();
    b.dispose();
  }
});
it('inherited visibility changes render participation without derived ECS rows', () => {
  const f = tilemapFixture();
  try {
    const parent = f.world
      .spawn({ component: Transform, data: {} }, { component: Visibility, data: { state: 1 } })
      .unwrap();
    f.world.addComponent(f.entity, { component: ChildOf, data: { parent } }).unwrap();
    expect(f.draw().dispatch).toHaveLength(0);
    f.world.set(parent, Visibility, { state: 2 }).unwrap();
    expect(f.draw().dispatch).toHaveLength(1);
    f.world.addComponent(f.entity, { component: Visibility, data: { state: 1 } }).unwrap();
    expect(f.draw().dispatch).toHaveLength(0);
    f.world.removeComponent(f.entity, Visibility).unwrap();
    expect(f.draw().dispatch).toHaveLength(1);
  } finally {
    f.dispose();
  }
});
it.each([
  0, 1,
])('dispatch layer ordering derives from the source and real chunk (sort %s)', (sortScope) => {
  const f = tilemapFixture({ cols: 6, rows: 1, chunkSize: 1, sortScope });
  try {
    f.world.set(f.entity, Tilemap, { layerOrder: 2 }).unwrap();
    expect(f.draw().dispatch.map((row) => row.layer)).toEqual(
      Array.from({ length: 6 }, (_, index) => (2 << 20) | (sortScope === 0 ? index : 0)),
    );
  } finally {
    f.dispose();
  }
});
it('publishes an edited borrowed cells array without losing unchanged cells', () => {
  const f = tilemapFixture({ cols: 8, rows: 8, chunkSize: 4 });
  try {
    f.draw();
    const cells = f.world.get(f.entity, Tilemap).unwrap().tiles;
    cells[0] = 0;
    f.world.set(f.entity, Tilemap, { tiles: cells }).unwrap();
    expect(f.world.get(f.entity, Tilemap).unwrap().tiles[63]).toBe(1);
    const frame = f.draw();
    expect(
      frame.renderables.reduce((n, row) => n + (row.generatedMesh?.indices?.length ?? 0) / 6, 0),
    ).toBe(63);
    expect(f.world.get(f.entity, Tilemap).unwrap().tiles[63]).toBe(1);
  } finally {
    f.dispose();
  }
});
