import { PhysicsWorldResource } from '@forgeax/engine/physics';
import { createWorldContext, World } from '@forgeax/engine/ecs';
import { definePackageId } from '@forgeax/engine/pack/source';
import { Collider, type PhysicsWorld, RigidBody } from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import {
  scenePlugin,
  Transform,
  WaterContactProbeSet,
  WaterPontoonSet,
  WaterShallowCollider,
} from '@forgeax/engine/scene';
import { buildWaterPackOutputs, WaterOceanPatch, WaterSystem } from '@forgeax/engine/water';
import { expect, it, vi } from 'vitest';
import {
  ironBallPhysics,
  ironBallSubmerged,
  readIronBallParticipation,
  releaseIronBallWaterCollider,
  sampleIronBallEntry,
} from '../iron-ball';

it('spawns an ordinary native iron ball without buoyancy or contact probes', () => {
  const world = new World();
  const ship = world.spawn({ component: WaterPontoonSet, data: {} }).unwrap();
  const entity = world
    .spawn({ component: Transform, data: { scale: [0.5, 0.5, 0.5] } }, ...ironBallPhysics(12, 0.6))
    .unwrap();
  expect(world.hasComponent(entity, RigidBody)).toBe(true);
  expect(world.hasComponent(entity, Collider)).toBe(true);
  expect(world.get(entity, Collider).unwrap().radius).toBeCloseTo(0.6);
  expect(world.hasComponent(entity, WaterShallowCollider)).toBe(true);
  expect(world.hasComponent(entity, WaterPontoonSet)).toBe(false);
  expect(world.hasComponent(entity, WaterContactProbeSet)).toBe(false);
  expect(world.hasComponent(ship, WaterPontoonSet)).toBe(true);
  expect(readIronBallParticipation(world, entity, false)).toEqual({
    buoyancyParticipant: false,
    contactProbeParticipant: false,
    shallowColliderParticipant: true,
    nativeEntryArmed: true,
  });
  world.addComponent(entity, { component: WaterPontoonSet, data: {} }).unwrap();
  expect(readIronBallParticipation(world, entity, true)).toEqual({
    buoyancyParticipant: true,
    contactProbeParticipant: false,
    shallowColliderParticipant: true,
    nativeEntryArmed: false,
  });
});

it('releases water collision participation without retiring an already enqueued wave impulse', () => {
  const world = new World();
  const entity = world.spawn(...ironBallPhysics(100, 0.6)).unwrap();
  const ocean = WaterOceanPatch.create({
    guid: '019a0000-0000-7000-8000-000000000400',
    contentVersion: 'iron-ball-entry',
    asset: {
      kind: 'water-simulation-recipe',
      system: 'water-advanced',
      configurationVersion: 1,
      enabledFeatures: ['oceanPatch'],
      materialGuids: [],
      textureGuids: [],
      oceanPatchConfig: {
        algorithm: 'mode-projected-gravity/1',
        fftResolution: 32,
        domainLengthM: 16,
        centerXZ: [0, 0],
        baseHeightM: 0,
        referenceDepthM: 4,
        gravityMPerSec2: 9.81,
        sourceSlabBoundariesM: [-4, -3, -2, -1, 0],
        collisions: {
          kind: 'simple',
          collisionGroups: 0xffffffff,
          maxElements: 10,
          fieldStepM: 0.1,
          maximumFieldSamplesPerColumn: 128,
        },
        maximumIntervalSeconds: 0.2,
        boundary: { kind: 'periodic' },
        foam: { slopeThreshold: 0.1, emissionPerSecond: 1, decayPerSecond: 0.1 },
        normalRtFormat: 'rgba32float',
        gridMesh: null,
      },
    },
  }).unwrap();
  const native = {};
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 1, 60).unwrap();
  const bootstrap = ocean.frame();
  if (!bootstrap) throw new Error('Expected native bootstrap frame');
  ocean.submitted(bootstrap).unwrap();
  ocean.allocated(1, 0);
  const sourceReceiver = { entity, generation: 1 };
  const sequence = ocean
    .enqueueWaveImpulse({
      positionXZ: [0, 0],
      radiusM: 0.6,
      velocityImpulseMps: 2,
      timeSeconds: 1,
      sourceReceiver,
    })
    .unwrap();
  const held = ocean.frame();
  if (!held) throw new Error('Expected native impulse frame');
  releaseIronBallWaterCollider(world, entity).unwrap();
  expect(world.hasComponent(entity, WaterShallowCollider)).toBe(false);
  expect(world.hasComponent(entity, Collider)).toBe(true);
  expect(world.hasComponent(entity, RigidBody)).toBe(true);
  expect(ocean.inspect().pendingWaveImpulses).toBe(1);
  ocean.discarded(held);
  const retry = ocean.frame();
  if (!retry) throw new Error('Expected retained impulse retry');
  expect(retry.waveImpulses).toHaveLength(1);
  expect(retry.waveImpulses?.[0]).toMatchObject({ sequence, sourceReceiver });
  ocean.submitted(retry).unwrap();
  expect(ocean.inspect().pendingWaveImpulses).toBe(0);
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 61 / 60, 61).unwrap();
  const next = ocean.frame();
  if (!next) throw new Error('Expected continuing native wave frame');
  expect(next.reset).toBe(false);
  expect(next.generation).toBe(retry.generation);
  expect(next.timeSeconds).toBeGreaterThan(retry.timeSeconds);
  ocean.submitted(next).unwrap();
  ocean.retire();
});

it('observes native entry without buoyancy and stops water queries after capture while physics continues', async () => {
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin(), physics3d]);
  const water = new WaterSystem(() => undefined);
  const packed = (
    await buildWaterPackOutputs(
      {
        body: {
          kind: 'water-body',
          type: 'lake',
          baseHeightM: 0,
          maxWaveHeightM: 0,
          overlapPriority: 0,
          shapeDilationM: 0,
          surfaceMaterialGuid: '00000000-0000-7000-8000-000000000001',
          flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
          collision: { type: 'polygon', enabled: false, channelDepthM: 20 },
          spline: {
            closed: true,
            points: [
              [-20, -20],
              [20, -20],
              [20, 20],
              [-20, 20],
            ].map(([x, z], inputKey) => ({
              inputKey,
              positionM: [x ?? 0, 0, z ?? 0],
              arriveTangentM: [0, 0, 0],
              leaveTangentM: [0, 0, 0],
              up: [0, 1, 0],
              rollAngle: 0,
              angleUnit: 'degrees',
              widthM: 20,
              depthM: 20,
              velocityMPerSec: 0,
              audioIntensity: 0,
            })),
          },
          queryFootprint: [
            [-20, -20],
            [20, -20],
            [20, 20],
            [-20, 20],
          ],
        },
      },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000399') },
    )
  ).unwrap().body;
  if (packed?.kind !== 'water-body') throw new Error('Expected cooked Water body');
  water.mountBody('entry-water', '1', packed).unwrap();
  const body = water.snapshot('entry-water');
  if (!body) throw new Error('Expected mounted Water body');
  const ball = world
    .spawn({ component: Transform, data: { pos: [0, 2, 0] } }, ...ironBallPhysics(100, 0.6))
    .unwrap();
  const physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
  const query = vi.spyOn(water, 'queryBody');
  let entryRecorded = false,
    surfaceY = 0,
    entryStep = 0,
    hidden = false,
    queriesAtEntry = 0,
    entryCount = 0;
  try {
    for (let step = 0; step < 100; step++) {
      world.update(1 / 60).unwrap();
      const dynamics = physics.getCommittedBodyDynamics?.(ball);
      const clock = physics.getSolverClock?.();
      if (!dynamics?.ok || !clock) throw new Error('Expected completed native dynamics');
      const sample = sampleIronBallEntry(water, body, dynamics.value, clock, entryRecorded);
      if (
        sample?.ok &&
        sample.value.surfaceM &&
        dynamics.value.positionM[1] - 0.6 <= sample.value.surfaceM[1]
      ) {
        entryRecorded = true;
        releaseIronBallWaterCollider(world, ball).unwrap();
        surfaceY = sample.value.surfaceM[1];
        entryStep = dynamics.value.completedStep;
        queriesAtEntry = query.mock.calls.length;
        entryCount++;
      }
      if (entryRecorded) {
        hidden ||= ironBallSubmerged(dynamics.value.positionM, 0.6, surfaceY);
        expect(readIronBallParticipation(world, ball, true)).toEqual({
          buoyancyParticipant: false,
          contactProbeParticipant: false,
          shallowColliderParticipant: false,
          nativeEntryArmed: false,
        });
        expect(query.mock.calls.length).toBe(queriesAtEntry);
      }
    }
    expect(entryRecorded).toBe(true);
    expect(entryCount).toBe(1);
    expect(hidden).toBe(true);
    expect(query.mock.calls.length).toBeLessThan(60);
    const dynamics = physics.getCommittedBodyDynamics?.(ball);
    if (!dynamics?.ok) throw new Error('Expected surviving native ball');
    expect(dynamics.value.completedStep).toBeGreaterThan(entryStep);
    expect(dynamics.value.positionM[1]).toBeLessThan(-2);
    expect(world.hasComponent(ball, Collider)).toBe(true);
    expect(world.hasComponent(ball, WaterShallowCollider)).toBe(false);
    expect(world.hasComponent(ball, RigidBody)).toBe(true);
    // Rising above the captured surface cannot reveal an already hidden ball.
    hidden ||= ironBallSubmerged([0, 3, 0], 0.6, surfaceY);
    expect(hidden).toBe(true);
  } finally {
    query.mockRestore();
    await context.fiber.dispose();
  }
});
