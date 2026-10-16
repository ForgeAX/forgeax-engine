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
import { describe, expect, it } from 'vitest';
import { NavigationAgent, NavigationAgentStatus, setNavigationPath } from '../agent';
import {
  NavigationCharacter,
  navigationCharacterPlugin,
  setNavigationMesh,
  setNavigationTarget,
} from '../character';
import { createNavigationMesh } from '../navmesh';

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
  const world = new World();
  const ctx = await createWorldContext(world, [
    ...(physics ? [physicsPlugin('rapier-3d')] : []),
    navigationCharacterPlugin(createNavigationMesh(asset).unwrap()),
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
  return { world, ctx, spawn };
}
describe('navigation through real Rapier KCC', () => {
  it('moves exactly once per fixed step, arrives from actual pose, and cancels/pauses without drift', async () => {
    const { world, ctx, spawn } = await setup();
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
      await ctx.fiber.dispose();
    }
  });
  it('waits for physics, invalidates old mesh paths, and rejects stale entities', async () => {
    const { world, ctx, spawn } = await setup(false);
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
        createNavigationMesh({ ...asset, sourceDigest: 'replacement' }).unwrap(),
      );
      world.update(1 / 60).unwrap();
      expect(world.get(e, NavigationAgent).unwrap().status).toBe(NavigationAgentStatus.idle);
      world.despawn(e).unwrap();
      expect(setNavigationTarget(world, e, [0, 0, 0], { maxProjection: 1 }).ok).toBe(false);
      await physics.dispose();
    } finally {
      await ctx.fiber.dispose();
    }
  });
  it('never crosses a physical wall or reports false arrival; stops bounded stalled work', async () => {
    const { world, ctx, spawn } = await setup();
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
      await ctx.fiber.dispose();
    }
  });
  it('passes two opposing characters without persistent overlap', async () => {
    const { world, ctx, spawn } = await setup();
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
      await ctx.fiber.dispose();
    }
  });
  it('follows a baked corridor corner without cutting it at the final arrival tolerance', async () => {
    const { world, ctx, spawn } = await setup();
    try {
      const vertices: number[] = [];
      for (const z of [-5, 1.7, 5]) for (const x of [-6, -0.6, 0.6, 6]) vertices.push(x, 0.05, z);
      setNavigationMesh(
        world,
        createNavigationMesh({
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
        }).unwrap(),
      );
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
      await ctx.fiber.dispose();
    }
  });
  it('converts physical world displacement under a yawed nonuniform parent', async () => {
    const { world, ctx, spawn } = await setup();
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
      await ctx.fiber.dispose();
    }
  });
});
