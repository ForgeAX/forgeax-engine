import { createWorldContext, World } from '@forgeax/engine-ecs';
import { ChildOf, GlobalTransform, scenePlugin, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  createNavigationGrid,
  NavigationAgent,
  NavigationAgentStatus,
  navigationPlugin,
  setNavigationPath,
} from '../index';

async function setup() {
  const world = new World({
    time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 10, maxDeltaSeconds: 1 },
  });
  const ctx = await createWorldContext(world, [navigationPlugin()]);
  const entity = world.spawn({ component: NavigationAgent, data: { speed: 12 } }).unwrap();
  return { world, ctx, entity };
}

describe('FixedUpdate path following in a real World', () => {
  it.each([
    3e38, 1e-38, 1.4e-45,
  ])('follows finite Float32 routes at coordinate scale %s', async (scale) => {
    const world = new World({
      time: { fixedDeltaSeconds: 1, maxStepsPerUpdate: 1, maxDeltaSeconds: 2 },
    });
    const ctx = await createWorldContext(world, [navigationPlugin()]);
    const start = new Float32Array([-scale, -scale, -scale]);
    const target = new Float32Array([scale, scale, scale]);
    const entity = world.spawn({ component: NavigationAgent, data: { speed: scale } }).unwrap();
    try {
      world.set(entity, Transform, { pos: start }).unwrap();
      setNavigationPath(world, entity, target).unwrap();
      const positions: number[][] = [];
      for (let frame = 0; frame < 6; frame++) {
        world.update(1).unwrap();
        const position = [...world.get(entity, Transform).unwrap().pos];
        positions.push(position);
        for (const value of position) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(start[0] as number);
          expect(value).toBeLessThanOrEqual(target[0] as number);
        }
      }
      expect(positions[0]?.[0]).toBeGreaterThan(start[0] as number);
      expect(positions[0]?.[0]).toBeLessThan(target[0] as number);
      expect(positions.at(-1)).toEqual([...target]);
      expect(world.get(entity, NavigationAgent).unwrap().status).toBe(
        NavigationAgentStatus.arrived,
      );
    } finally {
      await ctx.fiber.dispose();
    }
  });
  it('composes with an existing Scene and preserves its lifetime on navigation disposal', async () => {
    const world = new World();
    const ctx = await createWorldContext(world, [scenePlugin()]);
    try {
      const navigation = await ctx.plugin(navigationPlugin());
      const entity = world.spawn({ component: NavigationAgent, data: { speed: 12 } }).unwrap();
      setNavigationPath(world, entity, [0.2, 0, 0]).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(entity, GlobalTransform).unwrap().world[12]).toBeCloseTo(0.2);
      await navigation.dispose();
      world.set(entity, Transform, { pos: [2, 0, 0] }).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(entity, GlobalTransform).unwrap().world[12]).toBe(2);
      expect(world.inspect().systems.some((s) => s.name === 'navigation/follow-path')).toBe(false);
    } finally {
      await ctx.fiber.dispose();
    }
  });
  it('turns every corner, consumes remaining distance and never overshoots', async () => {
    const { world, ctx, entity } = await setup();
    try {
      setNavigationPath(
        world,
        entity,
        [0, 0, 0, 0.125, 0, 0, 0.125, 0, 0.125, 0.25, 0, 0.125],
      ).unwrap();
      world.set(entity, NavigationAgent, { speed: 15 }).unwrap();
      world.update(1 / 60).unwrap();
      expect([...world.get(entity, Transform).unwrap().pos]).toEqual([
        expect.closeTo(0.125, 5),
        0,
        expect.closeTo(0.125, 5),
      ]);
      const matrix = world.get(entity, GlobalTransform).unwrap().world;
      expect(matrix[12]).toBeCloseTo(0.125);
      expect(matrix[14]).toBeCloseTo(0.125);
      world.update(1 / 60).unwrap();
      expect(world.get(entity, NavigationAgent).unwrap().status).toBe(
        NavigationAgentStatus.arrived,
      );
      for (let i = 0; i < 60; i++) world.update(1 / 60).unwrap();
      expect([...world.get(entity, Transform).unwrap().pos]).toEqual([
        expect.closeTo(0.25, 5),
        0,
        expect.closeTo(0.125, 5),
      ]);
    } finally {
      await ctx.fiber.dispose();
    }
  });
  it('uses local coordinates under a translated parent and propagates in the same tick', async () => {
    const { world, ctx, entity } = await setup();
    try {
      const parent = world.spawn({ component: Transform, data: { pos: [10, 5, -2] } }).unwrap();
      world.addComponent(entity, { component: ChildOf, data: { parent } }).unwrap();
      setNavigationPath(world, entity, [0.2, 0, 0]).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(entity, GlobalTransform).unwrap().world[12]).toBeCloseTo(10.2);
    } finally {
      await ctx.fiber.dispose();
    }
  });
  it('matches different host cadences at the same fixed simulation time', async () => {
    const a = await setup();
    const b = await setup();
    try {
      const points = [0, 0, 0, 0, 0, 30, 30, 0, 30];
      setNavigationPath(a.world, a.entity, points).unwrap();
      setNavigationPath(b.world, b.entity, points).unwrap();
      for (let i = 0; i < 60; i++) a.world.update(1 / 60).unwrap();
      for (let i = 0; i < 30; i++) b.world.update(1 / 30).unwrap();
      expect([...a.world.get(a.entity, Transform).unwrap().pos]).toEqual([
        ...b.world.get(b.entity, Transform).unwrap().pos,
      ]);
      expect(a.world.get(a.entity, Transform).unwrap().pos[2]).toBeCloseTo(12, 4);
      expect(a.world.get(a.entity, NavigationAgent).unwrap().status).toBe(
        NavigationAgentStatus.following,
      );
    } finally {
      await a.ctx.fiber.dispose();
      await b.ctx.fiber.dispose();
    }
  });
  it('follows a computed wall detour without entering blocked cells', async () => {
    const { world, ctx, entity } = await setup();
    try {
      const blocked = new Uint8Array(25);
      for (const id of [2, 7, 12, 17]) blocked[id] = 1;
      const path = createNavigationGrid({ width: 5, height: 5, blocked })
        .unwrap()
        .findPath(0, 4)
        .unwrap();
      setNavigationPath(world, entity, path.points).unwrap();
      for (let frame = 0; frame < 120; frame++) {
        world.update(1 / 60).unwrap();
        const pos = world.get(entity, Transform).unwrap().pos;
        const cell = Math.round(pos[2] as number) * 5 + Math.round(pos[0] as number);
        expect(blocked[cell]).toBe(0);
      }
      expect([...world.get(entity, Transform).unwrap().pos]).toEqual([4, 0, 0]);
      expect(world.get(entity, NavigationAgent).unwrap().status).toBe(
        NavigationAgentStatus.arrived,
      );
    } finally {
      await ctx.fiber.dispose();
    }
  });
  it('suspends and resumes a retained route without rewinding its waypoint', async () => {
    const { world, ctx, entity } = await setup();
    try {
      setNavigationPath(world, entity, [0, 0, 0, 0, 0, 0, 0, 0, 5]).unwrap();
      world.set(entity, NavigationAgent, { status: NavigationAgentStatus.idle }).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(entity, NavigationAgent).unwrap().waypoint).toBe(0);
      world.set(entity, NavigationAgent, { status: NavigationAgentStatus.following }).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(entity, NavigationAgent).unwrap().waypoint).toBe(2);
      const position = [...world.get(entity, Transform).unwrap().pos];
      expect(position[2]).toBeCloseTo(0.2);
      world.set(entity, NavigationAgent, { status: NavigationAgentStatus.idle }).unwrap();
      for (let i = 0; i < 60; i++) world.update(1 / 60).unwrap();
      expect([...world.get(entity, Transform).unwrap().pos]).toEqual(position);
      expect(world.get(entity, NavigationAgent).unwrap().waypoint).toBe(2);
      world.set(entity, NavigationAgent, { status: NavigationAgentStatus.following }).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(entity, Transform).unwrap().pos[2]).toBeCloseTo(0.4);
      expect(world.get(entity, NavigationAgent).unwrap().path.length).toBe(9);
    } finally {
      await ctx.fiber.dispose();
    }
  });
  it('cancels and replaces paths atomically; rejects invalid inputs without losing the route', async () => {
    const { world, ctx, entity } = await setup();
    try {
      setNavigationPath(world, entity, [0, 0, 5]).unwrap();
      expect(setNavigationPath(world, entity, [NaN, 0, 0]).ok).toBe(false);
      expect(setNavigationPath(world, entity, [1]).ok).toBe(false);
      expect(setNavigationPath(world, entity, { length: -3 }).ok).toBe(false);
      expect([...world.get(entity, NavigationAgent).unwrap().path]).toEqual([0, 0, 5]);
      setNavigationPath(world, entity, []).unwrap();
      world.update(1 / 60).unwrap();
      expect([...world.get(entity, Transform).unwrap().pos]).toEqual([0, 0, 0]);
      setNavigationPath(world, entity, [0.125, 0, 0]).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(entity, NavigationAgent).unwrap().status).toBe(
        NavigationAgentStatus.arrived,
      );
    } finally {
      await ctx.fiber.dispose();
    }
    expect(world.inspect().systems.some((s) => s.name === 'navigation/follow-path')).toBe(false);
    const frozen = [...world.get(entity, Transform).unwrap().pos];
    world.update(1 / 60).unwrap();
    expect([...world.get(entity, Transform).unwrap().pos]).toEqual(frozen);
  });
});
