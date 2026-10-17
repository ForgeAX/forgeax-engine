import type { PhysicsConstraintInput } from '@forgeax/engine-physics';
import { ok } from '@forgeax/engine-types';
import { beforeAll, expect, it, vi } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D, type Rapier3DModule } from '../wasm-loader.js';

let rapier: Rapier3DModule;
beforeAll(async () => {
  const loaded = await loadRapier3D();
  if ('code' in loaded) throw loaded;
  rapier = loaded;
});

function fixture() {
  const physics = createRapier3DPhysicsWorld(rapier);
  for (const entity of [1, 2]) {
    const body = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(entity * 3, 0, 0),
    );
    body.userData = entity;
    physics.registerBody(entity, body.handle);
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity,
        sourceKey: `body/${entity}`,
        revision: 1,
        bodyType: 'dynamic',
        massProperties: { mode: 'automatic', density: 1 },
        shapes: [
          {
            kind: 'convex-compound',
            id: 'compound',
            revision: 1,
            pieces: [boxPoints([-1, -1, -1], [0, 1, 1]), boxPoints([0, -1, -1], [1, 1, 1])],
          },
        ],
      })
      .unwrap();
    physics.admitDerivedShapeCandidate(candidate).unwrap();
  }
  physics.step(1 / 60);
  return physics;
}

const constraint = (revision: number): PhysicsConstraintInput => ({
  id: 'spring',
  revision,
  kind: 'spring',
  bodyA: 1,
  bodyB: 2,
  bodyASource: { sourceKey: 'body/1', revision: 1 },
  bodyBSource: { sourceKey: 'body/2', revision: 1 },
  anchorA: [0, 0, 0],
  anchorB: [0, 0, 0],
  restLength: 3,
  stiffness: 20,
  damping: 1,
});

it('observes fresh committed constraint revisions without copying geometry or reading motion', () => {
  const physics = fixture();
  try {
    expect(physics.getDerivedConstraintStates()).toEqual([]);
    physics.createDerivedConstraint(constraint(1)).unwrap();
    const motion = vi.spyOn(physics, 'getDerivedMotion');
    const states = physics.getDerivedConstraintStates();
    expect(states).toEqual([{ id: 'spring', revision: 1, bodyA: 1, bodyB: 2 }]);
    expect(motion).not.toHaveBeenCalled();
    const snapshot = physics.captureDerivedPhysicsState();
    expect(motion).toHaveBeenCalledTimes(2);
    expect(snapshot.bodies.every((body) => body.shapes.length === 1)).toBe(true);
    expect(
      snapshot.bodies
        .flatMap((body) => body.shapes)
        .reduce(
          (bytes, shape) =>
            bytes +
            (shape.kind === 'heightfield'
              ? shape.heights.byteLength
              : shape.kind === 'voxels'
                ? shape.regions.byteLength
                : shape.pieces.reduce((total, piece) => total + piece.byteLength, 0)),
          0,
        ),
    ).toBe(384);
    expect(
      Array.from(
        new Map(
          snapshot.bodies
            .flatMap((body) => body.constraints)
            .map(({ id, revision, bodyA, bodyB }) => [id, { id, revision, bodyA, bodyB }]),
        ).values(),
      ),
    ).toEqual(states);
    const first = states[0];
    if (first === undefined) throw new Error('expected the committed spring');
    Object.assign(first, { revision: 99, bodyA: 42 });
    expect(physics.getDerivedConstraintStates()[0]?.revision).toBe(1);
    physics.updateDerivedConstraint(constraint(2)).unwrap();
    expect(physics.getDerivedConstraintStates()).toEqual([
      { id: 'spring', revision: 2, bodyA: 1, bodyB: 2 },
    ]);
    expect(physics.updateDerivedConstraint(constraint(2)).ok).toBe(false);
    expect(physics.getDerivedConstraintStates()[0]?.revision).toBe(2);
    physics.removeDerivedConstraint('spring').unwrap();
    expect(physics.getDerivedConstraintStates()).toEqual([]);
    motion.mockRestore();
  } finally {
    physics.dispose();
  }
});

it('keeps the full recovery capture intact and follows body retirement and restoration', () => {
  const physics = fixture();
  try {
    physics.createDerivedConstraint(constraint(1)).unwrap();
    const snapshot = physics.captureDerivedPhysicsState();
    const states = physics.getDerivedConstraintStates();
    physics.removeEntity(1);
    expect(physics.getDerivedConstraintStates()).toEqual([]);
    physics.removeEntity(2);
    for (const entity of [1, 2]) {
      const body = physics.raw.createRigidBody(rapier.RigidBodyDesc.dynamic());
      body.userData = entity;
      physics.registerBody(entity, body.handle);
    }
    physics.restoreDerivedPhysicsState(snapshot).unwrap();
    physics.step(1 / 60);
    expect(physics.getDerivedConstraintStates()).toEqual(states);
    const restored = physics.captureDerivedPhysicsState();
    expect(restored.bodies.map((body) => body.shapes)).toEqual(
      snapshot.bodies.map((body) => body.shapes),
    );
    expect(restored.bodies.flatMap((body) => body.constraints)).toEqual(
      snapshot.bodies.flatMap((body) => body.constraints),
    );
  } finally {
    physics.dispose();
  }
  expect(() => physics.getDerivedConstraintStates()).toThrow();
});

it('retains the native execution guard and its original committed owner', () => {
  const physics = fixture();
  try {
    physics.createDerivedConstraint(constraint(1)).unwrap();
    const step = physics.raw.step.bind(physics.raw);
    const spy = vi.spyOn(physics.raw, 'step').mockImplementation((...args) => {
      expect(() => physics.getDerivedConstraintStates()).toThrow('cannot reenter native execution');
      return step(...args);
    });
    physics.step(1 / 60);
    spy.mockRestore();
    expect(physics.getDerivedConstraintStates()).toEqual([
      { id: 'spring', revision: 1, bodyA: 1, bodyB: 2 },
    ]);
  } finally {
    physics.dispose();
  }
});

it('rejects observations during paired geometry admission instead of exposing partial constraints', () => {
  const physics = fixture();
  try {
    physics.createDerivedConstraint(constraint(1)).unwrap();
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity: 1,
        sourceKey: 'body/1',
        revision: 2,
        bodyType: 'dynamic',
        shapes: [
          {
            kind: 'convex-compound',
            id: 'replacement',
            revision: 2,
            pieces: [boxPoints([-1, -1, -1], [1, 1, 1])],
          },
        ],
      })
      .unwrap();
    let callbacks = 0;
    physics
      .admitDerivedShapeCandidate(candidate, () => {
        callbacks += 1;
        expect(() => physics.getDerivedConstraintStates()).toThrow();
        expect(() => physics.captureDerivedPhysicsState()).toThrow();
        return ok(undefined);
      })
      .unwrap();
    expect(physics.getDerivedConstraintStates()[0]?.revision).toBe(1);
    physics.step(1 / 60);
    expect(callbacks).toBe(1);
    expect(physics.getDerivedConstraintStates()).toEqual([]);
  } finally {
    physics.dispose();
  }
});
