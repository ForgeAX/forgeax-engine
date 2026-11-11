import { createInputSnapshot, INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine/input';
import { propagateTransforms, Transform } from '@forgeax/engine/scene';
import { describe, expect, it, vi } from 'vitest';
import { pluginFixture } from '../../__tests__/plugin-fixture.ts';
import type { Game3dPlayerService, PlayerLook } from '../../shared/player-protocol.ts';
import { camera as cameraPlugin } from '../camera.pack.ts';

/** The camera only needs the game3dPlayer service contract, not the player plugin. */
async function cameraFixture() {
  const base = await pluginFixture();
  base.world.insertResource(INPUT_SNAPSHOT_RESOURCE_KEY, createInputSnapshot());
  let look: PlayerLook = { yaw: 0, pitch: 0.3 };
  const listeners = new Set<() => void>();
  const player = base.entity('player');
  // The game's player reads back as its current presentation pose (interpolated physics);
  // the fixture has no physics, so it propagates the authored pose right away.
  const placePlayer = (position: readonly number[]) => {
    base.world.set(player, Transform, { pos: [...position] }).unwrap();
    propagateTransforms(base.world).unwrap();
  };
  const service: Game3dPlayerService = {
    entity: player,
    readInput: () => ({ horizontal: 0, vertical: 0, lookX: 0, lookY: 0, run: false }),
    readLook: () => look,
    setLook: (next) => { look = next; },
    teleport: (position) => {
      placePlayer(position);
      for (const listener of listeners) listener();
    },
    onTeleport: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  base.ctx.provide('game3dPlayer', service);
  return { ...base, service, placePlayer };
}

describe('game-3d camera', () => {
  it('writes the pose once, repairs external edits, and releases pointer lock with the plugin', async () => {
    const { world, ctx, entity, pointerLock } = await cameraFixture();
    try {
      const fiber = await ctx.plugin(cameraPlugin);
      expect(pointerLock).toHaveBeenLastCalledWith(true);
      const camera = entity('camera');
      const set = vi.spyOn(world, 'set');
      world.update(1 / 60).unwrap();
      const pose = world.get(camera, Transform).unwrap();
      world.update(1 / 60).unwrap();
      expect(set.mock.calls.filter(([target, component]) => target === camera && component === Transform)).toHaveLength(1);
      world.set(camera, Transform, { pos: [99, 99, 99] }).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(camera, Transform).unwrap().pos).toEqual(pose.pos);
      await fiber.dispose();
      expect(pointerLock).toHaveBeenLastCalledWith(false);
      expect(world.get(camera, Transform).ok).toBe(true);
      expect(world.inspect().systems.some((system) => system.name === 'game-3d-camera')).toBe(false);
    } finally { await ctx.fiber.dispose(); }
  });

  it('eases after the player walks, snaps after a teleport', async () => {
    const { world, ctx, entity, service, placePlayer } = await cameraFixture();
    try {
      await ctx.plugin(cameraPlugin);
      const camera = entity('camera');
      const cameraZ = () => world.get(camera, Transform).unwrap().pos[2] ?? 0;
      world.update(1 / 60).unwrap();
      const start = cameraZ();
      placePlayer([0, 0, 10]);
      world.update(1 / 60).unwrap();
      expect(cameraZ() - start).toBeGreaterThan(0);
      expect(cameraZ() - start).toBeLessThan(5);
      service.teleport([0, 0, -40]);
      world.update(1 / 60).unwrap();
      expect(cameraZ()).toBeCloseTo(start - 40, 3);
    } finally { await ctx.fiber.dispose(); }
  });

  it('pulls in front of a collider between the player and the orbit, then eases back out', async () => {
    const { world, ctx, entity } = await cameraFixture();
    let hit: { timeOfImpact: number } | undefined = { timeOfImpact: 2 };
    world.insertResource('PhysicsWorld', {
      raycast: () => (hit === undefined ? undefined : { entity: 0, point: [0, 0, 0], normal: [0, 0, 1], ...hit }),
    });
    try {
      await ctx.plugin(cameraPlugin);
      const camera = entity('camera');
      const focusDistance = () => {
        const pos = world.get(camera, Transform).unwrap().pos;
        return Math.hypot(pos[0] ?? 0, (pos[1] ?? 0) - 0.5, pos[2] ?? 0);
      };
      world.update(1 / 60).unwrap();
      expect(focusDistance()).toBeCloseTo(0.6 + 2 - 0.3, 3);
      hit = undefined;
      world.update(1 / 60).unwrap();
      const easing = focusDistance();
      expect(easing).toBeGreaterThan(2.3);
      expect(easing).toBeLessThan(6.5);
      for (let frame = 0; frame < 120; frame += 1) world.update(1 / 60).unwrap();
      expect(focusDistance()).toBeCloseTo(6.5, 2);
    } finally { await ctx.fiber.dispose(); }
  });
});
