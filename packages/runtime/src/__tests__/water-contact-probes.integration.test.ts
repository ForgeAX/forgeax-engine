import { createWorldContext, defineSystem, Time, Update, World } from '@forgeax/engine-ecs';
import { definePackageId } from '@forgeax/engine-pack/source';
import {
  Collider,
  type PhysicsWorld,
  PhysicsWorldResource,
  RigidBody,
} from '@forgeax/engine-physics';
import physics3d from '@forgeax/engine-physics-rapier3d';
import { scenePlugin, Transform, WaterContactProbeSet } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import {
  buildWaterPackOutputs,
  cookWaterAsset,
  WaterSystem,
  type WaterVisualContactState,
} from '@forgeax/engine-water';
import { expect, it, vi } from 'vitest';
import {
  installWaterContactProbes,
  WATER_VISUAL_CONTACTS_RESOURCE,
} from '../water-contact-probes.js';
import { WaterContactProbes } from '../water-system-order.js';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const waveGuid = '019a0000-0000-7000-8000-000000000571';
const read = (world: World) =>
  world.getResource<WaterVisualContactState>(WATER_VISUAL_CONTACTS_RESOURCE);
const settle = (world: World) => {
  for (let step = 0; step < 3; step++) world.update(1 / 60).unwrap();
};

async function fixture(withWaves = false) {
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin(), physics3d]);
  const waves = cookWaterAsset({
    kind: 'water-wave-set',
    waveSource: {
      kind: 'predefined',
      waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.5, steepness: 0 }],
    },
    depthMaskM: 0,
    maxWaveHeightM: 0.5,
    timeSource: 'scene-clock',
  }).unwrap();
  const water = new WaterSystem(
    () => undefined,
    () =>
      withWaves
        ? [
            {
              guid: waveGuid,
              field: 'waveSetGuid',
              kind: 'water-wave-set',
              status: 'valid',
              payload: waves,
            },
          ]
        : [],
  );
  const outputs = (
    await buildWaterPackOutputs(
      {
        body: {
          kind: 'water-body',
          type: 'lake',
          baseHeightM: 0,
          maxWaveHeightM: 0.5,
          ...(withWaves ? { waveSetGuid: waveGuid } : {}),
          overlapPriority: 0,
          shapeDilationM: 0,
          surfaceMaterialGuid: '019a0000-0000-7000-8000-000000000572',
          flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
          collision: { type: 'polygon', enabled: false, channelDepthM: 10 },
          queryFootprint: [
            [-30, -30],
            [30, -30],
            [30, 30],
            [-30, 30],
          ],
          spline: {
            closed: true,
            points: [
              [-30, -30],
              [30, -30],
              [30, 30],
              [-30, 30],
            ].map(([x, z], inputKey) => ({
              inputKey,
              positionM: [requiredFixtureValue(x), 0, requiredFixtureValue(z)],
              arriveTangentM: [0, 0, 0],
              leaveTangentM: [0, 0, 0],
              up: [0, 1, 0],
              rollAngle: 0,
              angleUnit: 'degrees',
              widthM: 10,
              depthM: 10,
              velocityMPerSec: 0,
              audioIntensity: 0,
            })),
          },
        },
      },
      {
        packageId: definePackageId('019a0000-0000-7000-8000-000000000579'),
        readByGuid: async () => ok(waves),
      },
    )
  ).unwrap();
  if (outputs.body?.kind !== 'water-body') throw new Error('Missing cooked contact Body');
  water.mountBody('water/contact', '1', outputs.body).unwrap();
  const bodyEntity = world.spawn({ component: Transform }).unwrap();
  const release = installWaterContactProbes(world, water, (entity) =>
    entity === bodyEntity ? water.snapshot('water/contact') : undefined,
  );
  return {
    world,
    water,
    bodyEntity,
    physics: world.getResource<PhysicsWorld>(PhysicsWorldResource),
    dispose: async () => {
      release();
      await context.fiber.dispose();
    },
  };
}

it('exposes the installed contact-probe boundary to an ordinary later consumer', async () => {
  const f = await fixture();
  try {
    const query = vi.spyOn(f.water, 'queryBody');
    f.world
      .spawn(
        { component: Transform },
        {
          component: WaterContactProbeSet,
          data: { body: f.bodyEntity, centersM: [0, 0, 0], radiiM: [0.3] },
        },
      )
      .unwrap();
    const observations: number[] = [];
    f.world
      .addSystem(
        Update,
        defineSystem({
          name: 'water-contact-consumer',
          after: [WaterContactProbes],
          queries: [],
          fn: () => {
            observations.push(query.mock.calls.length);
          },
        }),
      )
      .unwrap();
    settle(f.world);
    expect(observations).toHaveLength(3);
    expect(observations[0]).toBeGreaterThan(0);
    expect(observations.at(-1)).toBe(query.mock.calls.length);
    expect(read(f.world).failures).toEqual([]);
  } finally {
    await f.dispose();
  }
});

it('publishes contact when an actual wave enters a static native sphere, then removes it when the wave exits', async () => {
  const f = await fixture(true);
  try {
    const root = f.world
      .spawn(
        { component: Transform },
        { component: RigidBody, data: { type: 0 } },
        { component: Collider },
        {
          component: WaterContactProbeSet,
          data: { body: f.bodyEntity, centersM: [0, 0, 0], radiiM: [0.2] },
        },
      )
      .unwrap();
    settle(f.world);
    const omega = Math.sqrt((9.8 * Math.PI) / 4);
    const sample = (time: number) => {
      while (f.world.getResource(Time).elapsed < time - 1e-10)
        f.world.update(Math.min(1 / 60, time - f.world.getResource(Time).elapsed)).unwrap();
      return read(f.world);
    };
    expect(read(f.world).contacts).toEqual([]);
    const wet = sample(Math.PI / (2 * omega));
    expect(wet.failures).toEqual([]);
    expect(wet.contacts).toHaveLength(1);
    expect(wet.contacts[0]?.contact.kind).toBe('water-plane-intersection');
    if (wet.contacts[0]?.contact.kind === 'water-plane-intersection')
      expect(wet.contacts[0].contact.radiusM).toBeCloseTo(0.2, 6);
    expect(wet.contacts[0]?.rootGeneration).toBe(
      requiredFixtureValue(f.physics.getCommittedBodyDynamics).call(f.physics, root).unwrap()
        .generation,
    );
    expect(sample(Math.PI / omega).contacts).toEqual([]);
    expect(
      requiredFixtureValue(f.physics.getCommittedBodyDynamics).call(f.physics, root).unwrap()
        .positionM,
    ).toEqual([0, 0, 0]);
  } finally {
    await f.dispose();
  }
});

it('uses the completed native clock for a Scene probe without a RigidBody', async () => {
  const f = await fixture();
  try {
    const queries = vi.spyOn(f.water, 'queryBody');
    f.world
      .spawn(
        { component: Transform },
        {
          component: WaterContactProbeSet,
          data: { body: f.bodyEntity, centersM: [0, 0, 0], radiiM: [0.3] },
        },
      )
      .unwrap();
    settle(f.world);
    f.world.update(0).unwrap();
    expect(read(f.world).failures).toEqual([]);
    const clock = requiredFixtureValue(f.physics.getSolverClock).call(f.physics);
    expect(queries.mock.calls.at(-1)?.[1].nativePhysics).toEqual({
      completedStep: clock.completedStep,
      timeSeconds: clock.simulationTimeSeconds,
    });
    expect(read(f.world).contacts[0]?.sourcePhysicsStep).toBe(clock.completedStep);
  } finally {
    await f.dispose();
  }
});

it('scales the probe center through the Scene transform while keeping its radius in authored world meters', async () => {
  const f = await fixture();
  try {
    f.world
      .spawn(
        { component: Transform, data: { pos: [10, -0.6, 4], scale: [2, 3, 4] } },
        { component: RigidBody, data: { type: 0 } },
        { component: Collider },
        {
          component: WaterContactProbeSet,
          data: { body: f.bodyEntity, centersM: [1, 0.2, -1], radiiM: [0.25] },
        },
      )
      .unwrap();
    settle(f.world);
    const state = read(f.world);
    expect(state.failures).toEqual([]);
    expect(state.contacts).toHaveLength(1);
    const contact = requiredFixtureValue(state.contacts[0]).contact;
    expect(contact.kind).toBe('water-plane-intersection');
    if (contact.kind !== 'water-plane-intersection') throw new Error('Missing sphere intersection');
    expect(contact.positionM[0]).toBeCloseTo(12, 5);
    expect(contact.positionM[1]).toBe(0);
    expect(contact.positionM[2]).toBeCloseTo(0, 5);
    expect(contact.radiusM).toBeCloseTo(0.25, 6);
  } finally {
    await f.dispose();
  }
});

it('qualifies replacement native roots and discards disabled, removed and unbound probe publications', async () => {
  const f = await fixture();
  try {
    const config = { body: f.bodyEntity, centersM: [0, 0, 0], radiiM: [0.3] };
    const root = f.world
      .spawn(
        { component: Transform },
        { component: RigidBody, data: { type: 0 } },
        { component: Collider },
        { component: WaterContactProbeSet, data: config },
      )
      .unwrap();
    settle(f.world);
    const original = requiredFixtureValue(read(f.world).contacts[0]);
    expect(original).toBeDefined();
    f.world.removeComponent(root, RigidBody).unwrap();
    f.world.removeComponent(root, Collider).unwrap();
    settle(f.world);
    f.world.addComponent(root, { component: RigidBody, data: { type: 0 } }).unwrap();
    f.world.addComponent(root, { component: Collider }).unwrap();
    f.world.update(0).unwrap();
    expect(read(f.world).contacts).toEqual([]);
    expect(read(f.world).failures[0]?.code).toBe('water-contact-dynamics-unavailable');
    settle(f.world);
    const replacement = requiredFixtureValue(read(f.world).contacts[0]);
    expect(replacement.rootGeneration).not.toBe(original.rootGeneration);
    expect(replacement.rootGeneration).toBe(
      requiredFixtureValue(f.physics.getCommittedBodyDynamics).call(f.physics, root).unwrap()
        .generation,
    );
    f.world.set(root, WaterContactProbeSet, { enabled: false }).unwrap();
    f.world.update(0).unwrap();
    expect(read(f.world)).toEqual({ roots: [], contacts: [], failures: [] });
    f.world.set(root, WaterContactProbeSet, { enabled: true }).unwrap();
    f.world.update(0).unwrap();
    expect(read(f.world).contacts).toHaveLength(1);
    f.world.removeComponent(root, WaterContactProbeSet).unwrap();
    f.world.update(0).unwrap();
    expect(read(f.world).contacts).toEqual([]);
    f.world.addComponent(root, { component: WaterContactProbeSet, data: config }).unwrap();
    f.world.update(0).unwrap();
    expect(read(f.world).contacts[0]?.sourceIdentity).not.toBe(original.sourceIdentity);
    f.water.unmountBody('water/contact');
    f.world.update(0).unwrap();
    expect(read(f.world).contacts).toEqual([]);
    expect(read(f.world).failures[0]?.code).toBe('water-contact-body-unavailable');
    f.world.despawn(root).unwrap();
    f.world.update(0).unwrap();
    expect(read(f.world)).toEqual({ roots: [], contacts: [], failures: [] });
  } finally {
    await f.dispose();
  }
});
