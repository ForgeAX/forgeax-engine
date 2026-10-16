import { World } from '@forgeax/engine-ecs';
import {
  Mobility,
  type MobilityDiagnostic,
  MobilityKindValue,
  subscribeMobilityDiagnostics,
} from '@forgeax/engine-scene';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RigidBody, RigidBodyTypeValue, registerPhysicsComponents } from '../components.js';
import {
  detectMobilityPhysicsConflict,
  MOBILITY_PHYSICS_CONFLICT_SYSTEM,
  registerMobilityPhysicsConflict,
} from '../mobility-conflict.js';

function physicsWorld(): World {
  const world = new World();
  registerPhysicsComponents(world);
  world.components.register(Mobility).unwrap();
  return world;
}

const staticMobility = { component: Mobility, data: { kind: MobilityKindValue.static } };

describe('mobility-physics-conflict', () => {
  let received: MobilityDiagnostic[];
  let unsubscribe: () => void;

  beforeEach(() => {
    received = [];
    unsubscribe = subscribeMobilityDiagnostics((_world, diagnostic) => received.push(diagnostic));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    unsubscribe();
    vi.restoreAllMocks();
  });

  it('reports static Mobility on dynamic and kinematic bodies once each', () => {
    const world = physicsWorld();
    const dynamic = world
      .spawn(staticMobility, { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } })
      .unwrap();
    const kinematic = world
      .spawn(staticMobility, {
        component: RigidBody,
        data: { type: RigidBodyTypeValue.kinematic },
      })
      .unwrap();
    detectMobilityPhysicsConflict(world);
    world.set(dynamic, RigidBody, { mass: 2 }).unwrap();
    detectMobilityPhysicsConflict(world);

    expect(received).toHaveLength(2);
    expect(received).toContainEqual(
      expect.objectContaining({
        code: 'mobility-physics-conflict',
        expected: expect.stringContaining("'static'"),
        hint: expect.stringContaining('movable'),
        detail: { entity: dynamic, rigidBodyType: 'dynamic' },
      }),
    );
    expect(received).toContainEqual(
      expect.objectContaining({ detail: { entity: kinematic, rigidBodyType: 'kinematic' } }),
    );
  });

  it('accepts consistent pairs and never derives one component from the other', () => {
    const world = physicsWorld();
    const fixed = world
      .spawn(staticMobility, { component: RigidBody, data: { type: RigidBodyTypeValue.static } })
      .unwrap();
    const moving = world
      .spawn(
        { component: Mobility, data: { kind: MobilityKindValue.movable } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
      )
      .unwrap();
    const scenery = world.spawn(staticMobility).unwrap();
    detectMobilityPhysicsConflict(world);

    expect(received).toEqual([]);
    expect(world.get(fixed, RigidBody).unwrap().type).toBe(RigidBodyTypeValue.static);
    expect(world.get(moving, Mobility).unwrap().kind).toBe(MobilityKindValue.movable);
    expect(world.get(scenery, RigidBody).ok).toBe(false);
  });

  it('reports when a conflicting RigidBody type or static declaration arrives later', () => {
    const world = physicsWorld();
    const body = world
      .spawn(staticMobility, { component: RigidBody, data: { type: RigidBodyTypeValue.static } })
      .unwrap();
    const scenery = world.spawn(staticMobility).unwrap();
    const simulated = world
      .spawn({ component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } })
      .unwrap();
    detectMobilityPhysicsConflict(world);
    expect(received).toEqual([]);

    world.set(body, RigidBody, { type: RigidBodyTypeValue.kinematic }).unwrap();
    world
      .addComponent(scenery, { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } })
      .unwrap();
    world.addComponent(simulated, staticMobility).unwrap();
    detectMobilityPhysicsConflict(world);
    expect(received.map((d) => d.detail.entity).sort()).toEqual([body, scenery, simulated].sort());
  });

  it('runs as an Update system and unregisters cleanly', () => {
    const world = physicsWorld();
    const release = registerMobilityPhysicsConflict(world);
    world
      .spawn(staticMobility, { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(received.map((d) => d.code)).toEqual(['mobility-physics-conflict']);
    release();
    expect(world.inspect().systems.some((s) => s.name === MOBILITY_PHYSICS_CONFLICT_SYSTEM)).toBe(
      false,
    );
  });
});
