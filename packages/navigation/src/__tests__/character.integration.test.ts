import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  physicsPlugin,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { ChildOf, GlobalTransform, Transform } from '@forgeax/engine-scene';
import type { NavigationMeshAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { NavigationAgent, NavigationAgentStatus, setNavigationPath } from '../agent';
import { navigationMeshContribution } from '../asset-decoder';
import {
  NavigationCharacter,
  navigationCharacterPlugin,
  setNavigationMesh,
  setNavigationTarget,
} from '../character';
import * as navmesh from '../navmesh';

const asset: NavigationMeshAsset = {
  kind: 'navigation-mesh',
  version: 'recast-poly/1',
  sourceDigest: 'fixture',
  settings: {
    radius: 0.65,
    height: 2.5,
    maxSlopeDeg: 45,
    maxStep: 0.3,
    cellSize: 0.1,
    cellHeight: 0.05,
  },
  vertices: [-10, 0.05, -10, 10, 0.05, -10, 10, 0.05, 10, -10, 0.05, 10],
  polygons: [[0, 1, 2, 3]],
};
async function setup(physics = true) {
  const assets = new AssetRegistry();
  assets.installDecoder(navigationMeshContribution.kind, navigationMeshContribution.decoder);
  const mesh = assets.create(asset).unwrap();
  const world = new World({ assets });
  const ctx = await createWorldContext(world, [
    ...(physics ? [physicsPlugin('rapier-3d')] : []),
    navigationCharacterPlugin(mesh),
  ]);
  world
    .spawn(
      { component: Transform, data: { pos: [0, -0.1, 0] } },
      { component: Collider, data: { halfExtents: [10, 0.1, 10] } },
    )
    .unwrap();
  const spawn = (x: number, z = 0) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0.82, z] } },
        { component: NavigationCharacter, data: {} },
        { component: NavigationAgent, data: { speed: 1.5 } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 },
        },
      )
      .unwrap();
  return {
    world,
    ctx,
    spawn,
    assets,
    mesh,
    async dispose() {
      await ctx.fiber.dispose();
      assets.dispose();
    },
  };
}
describe('navigation through real Rapier KCC', () => {
  it('moves exactly once per fixed step, arrives from actual pose, and cancels/pauses without drift', async () => {
    const { world, dispose, spawn } = await setup();
    try {
      const e = spawn(-2);
      setNavigationTarget(world, e, [2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(e, Transform).unwrap().pos[0]).toBeCloseTo(-1.975, 3);
      expect(setNavigationPath(world, e, [8, 0, 0]).ok).toBe(false);
      world.set(e, NavigationAgent, { status: NavigationAgentStatus.idle }).unwrap();
      const paused = [...world.get(e, Transform).unwrap().pos];
      for (let i = 0; i < 20; i++) world.update(1 / 60).unwrap();
      expect([...world.get(e, Transform).unwrap().pos]).toEqual(paused);
      world.set(e, NavigationAgent, { status: NavigationAgentStatus.following }).unwrap();
      for (let i = 0; i < 200; i++) world.update(1 / 60).unwrap();
      expect(world.get(e, NavigationAgent).unwrap().status).toBe(NavigationAgentStatus.arrived);
      expect(Math.abs((world.get(e, Transform).unwrap().pos[0] as number) - 2)).toBeLessThanOrEqual(
        0.08,
      );
      setNavigationTarget(world, e, [-2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      setNavigationPath(world, e, []).unwrap();
      const stopped = [...world.get(e, Transform).unwrap().pos];
      world.update(1 / 60).unwrap();
      expect([...world.get(e, Transform).unwrap().pos]).toEqual(stopped);
    } finally {
      await dispose();
    }
  });
  it('waits for physics, invalidates old mesh paths, and rejects stale entities', async () => {
    const { world, ctx, dispose, spawn, assets } = await setup(false);
    try {
      const e = spawn(-2);
      setNavigationTarget(world, e, [2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      const loading = ctx.plugin(physicsPlugin('rapier-3d'));
      for (let i = 0; i < 60; i++) world.update(1 / 60).unwrap();
      expect(world.get(e, Transform).unwrap().pos[0]).toBe(-2);
      const physics = await loading;
      world.update(1 / 60).unwrap();
      expect(world.get(e, Transform).unwrap().pos[0]).toBeGreaterThan(-2);
      setNavigationMesh(
        world,
        assets.create({ ...asset, sourceDigest: 'replacement' }).unwrap(),
      ).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(e, NavigationAgent).unwrap().status).toBe(NavigationAgentStatus.idle);
      world.despawn(e).unwrap();
      expect(setNavigationTarget(world, e, [0, 0, 0], { maxProjection: 1 }).ok).toBe(false);
      await physics.dispose();
    } finally {
      await dispose();
    }
  });
  it('never crosses a physical wall or reports false arrival; stops bounded stalled work', async () => {
    const { world, dispose, spawn } = await setup();
    try {
      world
        .spawn(
          { component: Transform, data: { pos: [0, 1, 0] } },
          { component: Collider, data: { halfExtents: [0.1, 1, 10] } },
        )
        .unwrap();
      const e = spawn(-2);
      world.set(e, NavigationCharacter, { stuckSeconds: 0.5 }).unwrap();
      setNavigationTarget(world, e, [2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      for (let i = 0; i < 240; i++) {
        world.update(1 / 60).unwrap();
        expect(world.get(e, Transform).unwrap().pos[0]).toBeLessThan(-0.39);
      }
      expect(world.get(e, NavigationAgent).unwrap().status).toBe(NavigationAgentStatus.blocked);
      expect(world.get(e, NavigationCharacter).unwrap().recoveryAttempts).toBe(2);
      const held = [...world.get(e, Transform).unwrap().pos];
      for (let i = 0; i < 120; i++) world.update(1 / 60).unwrap();
      expect([...world.get(e, Transform).unwrap().pos]).toEqual(held);
    } finally {
      await dispose();
    }
  });
  it('passes two opposing characters without persistent overlap', async () => {
    const { world, dispose, spawn } = await setup();
    try {
      const a = spawn(-2),
        b = spawn(2);
      setNavigationTarget(world, a, [2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      setNavigationTarget(world, b, [-2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      let minimum = Infinity;
      for (let i = 0; i < 500; i++) {
        world.update(1 / 60).unwrap();
        const pa = world.get(a, Transform).unwrap().pos,
          pb = world.get(b, Transform).unwrap().pos;
        minimum = Math.min(
          minimum,
          Math.hypot((pa[0] as number) - (pb[0] as number), (pa[2] as number) - (pb[2] as number)),
        );
      }
      expect(minimum).toBeGreaterThan(0.59);
      expect(world.get(a, NavigationAgent).unwrap().status).toBe(NavigationAgentStatus.arrived);
      expect(world.get(b, NavigationAgent).unwrap().status).toBe(NavigationAgentStatus.arrived);
    } finally {
      await dispose();
    }
  });
  it('follows a baked corridor corner without cutting it at the final arrival tolerance', async () => {
    const { world, dispose, spawn, assets } = await setup();
    try {
      const vertices: number[] = [];
      for (const z of [-5, 1.7, 5]) for (const x of [-6, -0.6, 0.6, 6]) vertices.push(x, 0.05, z);
      setNavigationMesh(
        world,
        assets
          .create({
            ...asset,
            sourceDigest: 'corner',
            settings: { ...asset.settings, radius: 0.35 },
            vertices,
            polygons: [
              [0, 1, 5, 4],
              [2, 3, 7, 6],
              [4, 5, 9, 8],
              [5, 6, 10, 9],
              [6, 7, 11, 10],
            ],
          })
          .unwrap(),
      ).unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [0, 1.5, -1] } },
          { component: Collider, data: { halfExtents: [0.2, 1.5, 2.5] } },
        )
        .unwrap();
      const e = spawn(-3, -3);
      setNavigationTarget(world, e, [3, 0.05, 3], { maxProjection: 0.2 }).unwrap();
      for (let i = 0; i < 900; i++) world.update(1 / 60).unwrap();
      expect(world.get(e, NavigationAgent).unwrap().status).toBe(NavigationAgentStatus.arrived);
      const p = world.get(e, Transform).unwrap().pos;
      expect(Math.hypot((p[0] as number) - 3, (p[2] as number) - 3)).toBeLessThanOrEqual(0.08);
    } finally {
      await dispose();
    }
  });
  it('converts physical world displacement under a yawed nonuniform parent', async () => {
    const { world, dispose, spawn } = await setup();
    try {
      const parent = world
        .spawn({
          component: Transform,
          data: { pos: [3, 0, 2], scale: [2, 1, 0.5], quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
        })
        .unwrap();
      const e = spawn(0);
      world.addComponent(e, { component: ChildOf, data: { parent } }).unwrap();
      world.set(e, Transform, { pos: [0, 1.12, 0] }).unwrap();
      setNavigationTarget(world, e, [3, 0.05, 4], { maxProjection: 0.2 }).unwrap();
      for (let i = 0; i < 180; i++) world.update(1 / 60).unwrap();
      const m = world.get(e, GlobalTransform).unwrap().world;
      expect(m[12]).toBeCloseTo(3, 1);
      expect(Math.abs((m[14] as number) - 4)).toBeLessThanOrEqual(0.08);
      expect(world.get(e, NavigationAgent).unwrap().status).toBe(NavigationAgentStatus.arrived);
      expect(world.get(e, CharacterController).unwrap().grounded).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('adopts same-digest geometry for synchronous queries without Physics and prepares only changed active content', async () => {
    const { world, dispose, spawn, assets, mesh } = await setup(false);
    const fixed = navmesh.createNavigationMesh(assets.read(mesh).unwrap()).unwrap();
    const prepare = vi.spyOn(navmesh, 'createNavigationMesh');
    const writes = vi.spyOn(world, 'set');
    try {
      const entity = spawn(-2);
      setNavigationTarget(world, entity, [2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      const before = world.get(entity, NavigationCharacter).unwrap().surfaceVersion;
      const oldPath = [...world.get(entity, NavigationAgent).unwrap().path];
      const unrelated = assets.create(asset).unwrap();
      assets.update(unrelated, { sourceDigest: 'unrelated' }).unwrap();
      for (let i = 0; i < 8; i++)
        setNavigationTarget(world, entity, [2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      expect(prepare).not.toHaveBeenCalled();

      writes.mockClear();
      assets
        .update(mesh, { vertices: asset.vertices.map((v, i) => (i % 3 === 0 && v > 0 ? 1 : v)) })
        .unwrap();
      assets
        .update(mesh, { vertices: asset.vertices.map((v, i) => (i % 3 === 0 && v > 0 ? 0 : v)) })
        .unwrap();
      expect(writes).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(assets.read(mesh).unwrap().sourceDigest).toBe(asset.sourceDigest);
      expect(setNavigationTarget(world, entity, [2, 0.05, 0], { maxProjection: 0.2 }).ok).toBe(
        false,
      );
      expect(prepare).toHaveBeenCalledTimes(1);
      expect([...world.get(entity, NavigationAgent).unwrap().path]).toEqual(oldPath);
      expect(fixed.project([2, 0.05, 0], 0.2).ok).toBe(true);
      setNavigationTarget(world, entity, [-1, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      expect(world.get(entity, NavigationCharacter).unwrap().surfaceVersion).not.toBe(before);
      for (let i = 0; i < 8; i++) world.update(1 / 60).unwrap();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(world.get(entity, Transform).unwrap().pos[0]).toBe(-2);
    } finally {
      writes.mockRestore();
      prepare.mockRestore();
      await dispose();
    }
  });

  it('cancels same-digest routes before motion and tolerates reduced clearance until explicit retarget', async () => {
    const { world, dispose, spawn, assets, mesh } = await setup();
    try {
      const entity = spawn(-2);
      setNavigationTarget(world, entity, [2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      world.update(1 / 60).unwrap();
      const held = [...world.get(entity, Transform).unwrap().pos];
      const writes = vi.spyOn(world, 'set');
      assets
        .update(mesh, { vertices: asset.vertices.map((v, i) => (i % 3 === 0 ? v * 0.9 : v)) })
        .unwrap();
      expect(writes).not.toHaveBeenCalled();
      writes.mockRestore();
      world.update(1 / 60).unwrap();
      expect(world.get(entity, NavigationAgent).unwrap().status).toBe(NavigationAgentStatus.idle);
      expect(world.get(entity, NavigationCharacter).unwrap().surfaceVersion).toBe('');
      expect([...world.get(entity, Transform).unwrap().pos]).toEqual(held);
      setNavigationTarget(world, entity, [2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      assets.update(mesh, { settings: { ...asset.settings, radius: 0.1, height: 0.5 } }).unwrap();
      for (let i = 0; i < 4; i++) world.update(1 / 60).unwrap();
      expect(world.get(entity, NavigationAgent).unwrap().status).toBe(NavigationAgentStatus.idle);
      expect([...world.get(entity, Transform).unwrap().pos]).toEqual(held);
      expect(setNavigationTarget(world, entity, [2, 0.05, 0], { maxProjection: 0.2 }).ok).toBe(
        false,
      );
    } finally {
      await dispose();
    }
  });

  it('owns the active reference, atomically rejects foreign replacements, and releases the final binding', async () => {
    const { world, ctx, dispose, spawn, assets, mesh } = await setup();
    const foreign = new AssetRegistry();
    foreign.installDecoder(navigationMeshContribution.kind, navigationMeshContribution.decoder);
    try {
      const entity = spawn(-2);
      const records = runtimeAssets(assets);
      expect(records.refcount(mesh)).toBe(2);
      assets.release(mesh).unwrap();
      setNavigationMesh(world, mesh).unwrap();
      setNavigationMesh(world, mesh).unwrap();
      expect(records.refcount(mesh)).toBe(1);
      setNavigationTarget(world, entity, [2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      const oldVersion = world.get(entity, NavigationCharacter).unwrap().surfaceVersion;
      const other = foreign.create(asset).unwrap();
      expect(setNavigationMesh(world, other).ok).toBe(false);
      expect(records.refcount(mesh)).toBe(1);
      expect(runtimeAssets(foreign).refcount(other)).toBe(1);
      const retired = assets.create(asset).unwrap();
      assets.release(retired).unwrap();
      expect(setNavigationMesh(world, retired).ok).toBe(false);
      expect(records.refcount(mesh)).toBe(1);
      setNavigationTarget(world, entity, [2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      expect(world.get(entity, NavigationCharacter).unwrap().surfaceVersion).toBe(oldVersion);
      const replacement = assets.create(asset).unwrap();
      setNavigationMesh(world, replacement).unwrap();
      assets.release(replacement).unwrap();
      expect(assets.read(mesh).ok).toBe(false);
      expect(records.refcount(replacement)).toBe(1);
      world.update(1 / 60).unwrap();
      expect(world.get(entity, NavigationAgent).unwrap().status).toBe(NavigationAgentStatus.idle);
      setNavigationTarget(world, entity, [2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      expect(world.get(entity, NavigationCharacter).unwrap().surfaceVersion).not.toBe(oldVersion);
      await ctx.fiber.dispose();
      expect(assets.read(replacement).ok).toBe(false);
      expect(setNavigationMesh(world, other).ok).toBe(false);
      expect(setNavigationTarget(world, entity, [2, 0.05, 0], { maxProjection: 0.2 }).ok).toBe(
        false,
      );
    } finally {
      foreign.dispose();
      await dispose();
    }
  });
});
