import { vec3 } from '@forgeax/engine-math';
import type { ColliderSnapshot } from '@forgeax/engine-physics';
import { describe, expect, it, vi } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

const pose = (x = 0) => ({
  position: { x, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
});
const body = (type = 1) => ({
  type,
  mass: 0,
  linearDamping: 0,
  angularDamping: 0,
  gravityScale: 0,
  ccdEnabled: 0,
});
const collider = (isSensor = false): ColliderSnapshot => ({
  shape: 0,
  mesh: 0,
  halfExtents: isSensor ? [2, 2, 2] : [0.5, 0.5, 0.5],
  radius: 0.5,
  halfHeight: 0.5,
  friction: 0,
  restitution: 0,
  density: 1,
  isSensor,
  collisionGroups: isSensor ? 0x0002_0001 : 0x0001_0002,
  solverGroups: 0xffff_ffff,
});
async function fixture() {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  physics.setGravity(vec3.create());
  physics.ensureBody(1, pose(), body(), collider());
  return physics;
}

describe('ordinary committed dynamics and fixed forces', () => {
  it('reads actual mass/inertia, applies native point force and torque, then expires both accumulators', async () => {
    const physics = await fixture();
    try {
      const before = physics.getCommittedBodyDynamics(1).unwrap();
      expect(before).toMatchObject({
        entity: 1,
        completedStep: 0,
        nextFixedStep: 1,
        massKg: 1,
        positionM: [0, 0, 0],
        localCenterOfMassM: [0, 0, 0],
        centerOfMassM: [0, 0, 0],
      });
      before.principalInertiaKgM2.forEach((value) => {
        expect(value).toBeCloseTo(1 / 6, 6);
      });
      const fence = { entity: 1, generation: before.generation, fixedStep: before.nextFixedStep };
      physics.applyBodyForceAtPoint({ ...fence, forceN: [0, 60, 0], pointM: [1, 0, 0] }).unwrap();
      physics.applyBodyTorque({ ...fence, torqueNm: [0, 0, 6] }).unwrap();
      physics.step(1 / 60);
      const applied = physics.getCommittedBodyDynamics(1).unwrap();
      expect(applied).toMatchObject({
        completedStep: 1,
        nextFixedStep: 2,
        generation: before.generation,
      });
      expect(applied.linearVelocityMps[1]).toBeCloseTo(1, 5);
      expect(applied.angularVelocityRadps[2]).toBeCloseTo(6.6, 4);
      expect(before.linearVelocityMps).toEqual([0, 0, 0]);
      physics.step(1 / 60);
      const dry = physics.getCommittedBodyDynamics(1).unwrap();
      expect(dry.linearVelocityMps[1]).toBeCloseTo(applied.linearVelocityMps[1], 6);
      expect(dry.angularVelocityRadps[2]).toBeCloseTo(applied.angularVelocityRadps[2], 5);
      expect(
        physics.applyBodyForceAtPoint({ ...fence, forceN: [0, 60, 0], pointM: [0, 0, 0] }),
      ).toMatchObject({ ok: false, error: { code: 'fixed-step-stale' } });
    } finally {
      physics.dispose();
    }
  });

  it('rejects missing, replaced, future-step, nonfinite and static force inputs', async () => {
    const physics = await fixture();
    try {
      const original = physics.getCommittedBodyDynamics(1).unwrap();
      const force = {
        entity: 1,
        generation: original.generation,
        fixedStep: original.nextFixedStep,
        forceN: [0, 1, 0] as const,
        pointM: [0, 0, 0] as const,
      };
      expect(physics.applyBodyForceAtPoint({ ...force, fixedStep: 2 })).toMatchObject({
        ok: false,
        error: { code: 'fixed-step-stale' },
      });
      expect(physics.applyBodyForceAtPoint({ ...force, forceN: [0, Number.NaN, 0] })).toMatchObject(
        { ok: false, error: { code: 'fixed-input-invalid' } },
      );
      expect(physics.applyBodyTorque({ ...force, torqueNm: [0, Infinity, 0] })).toMatchObject({
        ok: false,
        error: { code: 'fixed-input-invalid' },
      });
      physics.removeEntity(1);
      expect(physics.getCommittedBodyDynamics(1)).toMatchObject({
        ok: false,
        error: { code: 'fixed-body-missing' },
      });
      physics.ensureBody(1, pose(), body(), collider());
      expect(physics.getCommittedBodyDynamics(1).unwrap().generation).not.toBe(original.generation);
      expect(physics.applyBodyForceAtPoint(force)).toMatchObject({
        ok: false,
        error: { code: 'fixed-generation-stale' },
      });
      physics.ensureBody(2, pose(10), body(0), collider());
      const fixed = physics.getCommittedBodyDynamics(2).unwrap();
      expect(
        physics.applyBodyForceAtPoint({ ...force, entity: 2, generation: fixed.generation }),
      ).toMatchObject({ ok: false, error: { code: 'fixed-input-invalid' } });
    } finally {
      physics.dispose();
    }
  });

  it('publishes complete persistent sensor rosters, stale generations and valid empty steps', async () => {
    const physics = await fixture();
    try {
      physics.ensureBody(2, pose(), body(0), collider(true));
      expect(physics.getSensorOverlaps(1)).toMatchObject({
        ok: false,
        error: { code: 'fixed-operation-unavailable' },
      });
      physics.step(1 / 60);
      const entered = physics.getSensorOverlaps(1).unwrap();
      expect(entered).toMatchObject({ completedStep: 1, rootEntity: 1, stale: [], exited: [] });
      expect(entered.current).toHaveLength(1);
      expect(entered.current).toEqual(entered.entered);
      expect(entered.current[0]).toMatchObject({ entity: 2, collisionGroups: 0x0002_0001 });
      expect(physics.getSensorOverlaps(1, 0x0001_0001).unwrap().current).toEqual([]);
      expect(physics.getSensorOverlaps(1, -1)).toMatchObject({
        ok: false,
        error: { code: 'fixed-input-invalid' },
      });
      physics.ensureBody(1, pose(99), body(), collider());
      expect(physics.getSensorOverlaps(1).unwrap().current).toEqual(entered.current);
      physics.step(1 / 60);
      expect(physics.getSensorOverlaps(1).unwrap()).toMatchObject({
        completedStep: 2,
        current: entered.current,
        entered: [],
        exited: [],
      });
      physics.removeEntity(2);
      const stale = physics.getSensorOverlaps(1).unwrap();
      expect(stale.current).toEqual([]);
      expect(stale.stale).toEqual(entered.current);
      physics.ensureBody(2, pose(), body(0), collider(true));
      expect(physics.getSensorOverlaps(1).unwrap().stale).toEqual(entered.current);
      physics.step(1 / 60);
      const replacement = physics.getSensorOverlaps(1).unwrap();
      expect(replacement.current).toHaveLength(1);
      expect(replacement.current[0]?.bodyGeneration).not.toBe(entered.current[0]?.bodyGeneration);
      expect(replacement.current[0]?.colliderId).not.toBe(entered.current[0]?.colliderId);
      expect(replacement.entered).toEqual(replacement.current);
      expect(replacement.exited).toEqual(entered.current);
      physics
        .setBodyMotion(1, {
          position: [10, 0, 0],
          rotation: [0, 0, 0, 1],
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
        })
        .unwrap();
      physics.step(1 / 60);
      expect(physics.getSensorOverlaps(1).unwrap()).toMatchObject({
        completedStep: 4,
        current: [],
        entered: [],
        exited: replacement.current,
        stale: [],
      });
      physics.step(1 / 60);
      expect(physics.getSensorOverlaps(1).unwrap()).toMatchObject({
        completedStep: 5,
        current: [],
        entered: [],
        exited: [],
        stale: [],
      });
    } finally {
      physics.dispose();
    }
  });

  it('keeps completed empty sensor receipts without querying the ordinary body roster', async () => {
    const physics = await fixture();
    const intersection = vi.spyOn(Reflect.get(physics, 'raw'), 'intersectionPairsWith');
    try {
      physics.step(1 / 60);
      expect(intersection).not.toHaveBeenCalled();
      expect(physics.getSensorOverlaps(1).unwrap()).toMatchObject({
        completedStep: 1,
        current: [],
        entered: [],
        exited: [],
        stale: [],
      });
      physics.ensureBody(2, pose(), body(0), collider(true));
      expect(physics.getSensorOverlaps(2)).toMatchObject({
        ok: false,
        error: { code: 'fixed-operation-unavailable' },
      });
      physics.step(1 / 60);
      const previous = physics.getSensorOverlaps(1).unwrap().current;
      expect(previous).toHaveLength(1);
      physics.removeEntity(2);
      expect(physics.getSensorOverlaps(1).unwrap().stale).toEqual(previous);
      intersection.mockClear();
      physics.step(1 / 60);
      expect(intersection).not.toHaveBeenCalled();
      expect(physics.getSensorOverlaps(1).unwrap()).toMatchObject({
        completedStep: 3,
        current: [],
        exited: previous,
        stale: [],
      });
      physics.step(1 / 60);
      expect(physics.getSensorOverlaps(1).unwrap()).toMatchObject({
        completedStep: 4,
        exited: [],
      });
      physics.removeEntity(1);
      physics.ensureBody(1, pose(), body(), collider());
      expect(physics.getSensorOverlaps(1)).toMatchObject({
        ok: false,
        error: { code: 'fixed-operation-unavailable' },
      });
    } finally {
      intersection.mockRestore();
      physics.dispose();
    }
  });
});
