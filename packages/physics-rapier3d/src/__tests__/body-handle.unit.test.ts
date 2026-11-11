import { expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d';
import { loadRapier3D } from '../wasm-loader';

async function fixture() {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  const spawn = () =>
    physics.ensureBody(
      7,
      {
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      { type: 2, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
      undefined,
    );
  return { physics, spawn };
}

it('returns the actual live native handle and no handle for missing entities', async () => {
  const { physics, spawn } = await fixture();
  try {
    expect(physics.getBodyHandle(7)).toBeUndefined();
    spawn();
    const handle = physics.getBodyHandle(7);
    expect(handle).toBeTypeOf('number');
    if (handle === undefined) throw Error('Expected the admitted native body handle');
    expect(physics.raw.bodies.get(handle)?.handle).toBe(handle);
    spawn();
    expect(physics.getBodyHandle(7)).toBe(handle);
    physics.removeEntity(7);
    expect(physics.getBodyHandle(7)).toBeUndefined();
  } finally {
    physics.dispose();
  }
});

it('distinguishes the same entity recreated at an identical native pose', async () => {
  const { physics, spawn } = await fixture();
  try {
    spawn();
    const before = physics.getBodyMotion(7).unwrap();
    const handle = physics.getBodyHandle(7);
    physics.removeEntity(7);
    spawn();
    expect(physics.getBodyMotion(7).unwrap()).toEqual(before);
    expect(physics.getBodyHandle(7)).not.toBe(handle);
  } finally {
    physics.dispose();
  }
});

it('requires the raw world identity as well as a handle when the world is replaced', async () => {
  const first = await fixture(),
    second = await fixture();
  try {
    first.spawn();
    second.spawn();
    expect(first.physics.getBodyHandle(7)).toBe(second.physics.getBodyHandle(7));
    expect(first.physics.raw).not.toBe(second.physics.raw);
  } finally {
    first.physics.dispose();
    second.physics.dispose();
  }
});

it('retains the existing disposed-world query guard', async () => {
  const { physics, spawn } = await fixture();
  spawn();
  physics.dispose();
  expect(() => physics.getBodyHandle(7)).toThrow('cannot run on a disposed instance');
});
