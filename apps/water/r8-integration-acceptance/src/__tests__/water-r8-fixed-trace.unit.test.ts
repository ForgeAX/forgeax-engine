import { definePackageId } from '@forgeax/engine/pack/source';
import type {
  PhysicsBodyDynamics,
  PhysicsSensorOverlap,
  PhysicsSensorOverlaps,
  PhysicsWorld,
} from '@forgeax/engine/physics';
import { err, ok } from '@forgeax/engine/types';
import {
  buildWaterPackOutputs,
  stepWaterBuoyancy,
  WATER_BUOYANCY_DEFAULTS,
  WaterBuoyancyCoefficientCache,
  type WaterBuoyancySettings,
  WaterSystem,
} from '@forgeax/engine/water';
import { describe, expect, it } from 'vitest';
import { snapshotWaterBuoyancyStepForTrace } from '../physics-trace';

describe('R8 completed physics trace', () => {
  it('projects the WaterQueryResult field facade in the physics trace', async () => {
    const packed = (
      await buildWaterPackOutputs(
        {
          body: {
            kind: 'water-body',
            type: 'river',
            surfaceMaterialGuid: '00000000-0000-7000-8000-000000000001',
            baseHeightM: 2,
            overlapPriority: 0,
            maxWaveHeightM: 0,
            flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
            collision: { type: 'river-prism', enabled: true },
            spline: {
              closed: false,
              points: [
                {
                  inputKey: 0,
                  positionM: [0, 0, 0],
                  arriveTangentM: [8, 0, 0],
                  leaveTangentM: [8, 0, 0],
                  up: [0, 1, 0],
                  rollAngle: 0,
                  angleUnit: 'degrees',
                  widthM: 4,
                  depthM: 3,
                  velocityMPerSec: 0,
                  audioIntensity: 0,
                },
                {
                  inputKey: 1,
                  positionM: [8, 0, 0],
                  arriveTangentM: [8, 0, 0],
                  leaveTangentM: [8, 0, 0],
                  up: [0, 1, 0],
                  rollAngle: 0,
                  angleUnit: 'degrees',
                  widthM: 4,
                  depthM: 3,
                  velocityMPerSec: 0,
                  audioIntensity: 0,
                },
              ],
            },
            queryFootprint: [
              [-2, -2],
              [10, -2],
              [10, 2],
              [-2, 2],
            ],
          },
        },
        { packageId: definePackageId('019a0000-0000-7000-8000-000000000399') },
      )
    ).unwrap();
    if (packed.body?.kind !== 'water-body') throw new Error('River fixture must cook');
    const bodyGuid = '00000000-0000-7000-8000-000000000002';
    const water = new WaterSystem(() => undefined);
    const body = water.mountBody(bodyGuid, 'v1', packed.body).unwrap();
    const dynamics: PhysicsBodyDynamics = {
      entity: 1,
      generation: 7,
      completedStep: 40,
      nextFixedStep: 41,
      massKg: 10,
      positionM: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      localCenterOfMassM: [0, 0, 0],
      centerOfMassM: [0, 0, 0],
      linearVelocityMps: [0, 0, 0],
      angularVelocityRadps: [0, 0, 0],
      principalInertiaKgM2: [2, 3, 4],
      principalInertiaLocalRotation: [0, 0, 0, 1],
    };
    const overlap = (entity: number): PhysicsSensorOverlap => ({
      entity,
      colliderId: `collider:${entity}`,
      generation: entity,
      bodyGeneration: entity,
      collisionGroups: 0xffff_ffff,
    });
    const overlaps: PhysicsSensorOverlaps = {
      rootEntity: dynamics.entity,
      rootGeneration: dynamics.generation,
      completedStep: dynamics.completedStep,
      current: [overlap(2), overlap(3)],
      entered: [],
      exited: [],
      stale: [],
    };
    const physics: Pick<PhysicsWorld, 'applyBodyForceAtPoint' | 'applyBodyTorque'> = {
      applyBodyForceAtPoint: () => ok(undefined),
      applyBodyTorque: () => ok(undefined),
    };
    const settings: WaterBuoyancySettings = {
      ...WATER_BUOYANCY_DEFAULTS,
      applyRiverForces: false,
    };
    const step = stepWaterBuoyancy({
      physics,
      water,
      dynamics,
      overlaps,
      coefficientCache: new WaterBuoyancyCoefficientCache(),
      settings,
      pontoons: [
        {
          id: 'p0',
          centerM: [0, 0, 0],
          coefficientPositionM: [0, 0, 0],
          anchor: 'relative',
          radiusM: 1,
          enabled: true,
        },
      ],
      fixedDeltaSeconds: 1 / 60,
      fixedTimeSeconds: 3.25,
      resolveBody: (candidate) =>
        candidate.entity === 2
          ? ok(body)
          : err({
              code: 'buoyancy-candidate-rejected',
              expected: 'a current Water publication',
              hint: 'mount the candidate Body before sampling',
              detail: { kind: 'candidate', reason: 'water-publication', overlap: candidate },
            }),
    }).unwrap();
    const trace = {
      step: 1,
      delta: 1 / 60,
      steps: [{ entity: dynamics.entity, result: { ok: true, value: step } }],
    };

    expect(() => structuredClone(trace)).toThrow(DOMException);

    const safeTrace = structuredClone({
      step: trace.step,
      delta: trace.delta,
      steps: [
        {
          entity: dynamics.entity,
          result: { ok: true, value: snapshotWaterBuoyancyStepForTrace(step) },
        },
      ],
    });
    const traceStep = safeTrace.steps[0];
    if (!traceStep) throw new Error('The fixed trace row must remain present');
    const pontoon = traceStep.result.value.pontoons[0];
    if (!pontoon) throw new Error('The pontoon trace must remain present');
    const [accepted, rejected] = pontoon.candidateRoster;
    if (!accepted) throw new Error('The accepted water candidate must remain present');
    expect(accepted.result.ok).toBe(true);
    if (!accepted.result.ok) throw new Error('The accepted water candidate must remain successful');
    expect(accepted.result.value).toMatchObject({
      bodyGuid,
      bodyGeneration: body.sceneGeneration,
      immersionM: expect.any(Number),
      valid: expect.arrayContaining(['immersion']),
    });
    expect(pontoon).toMatchObject({
      physicsStep: dynamics.nextFixedStep,
      completedOverlapStep: overlaps.completedStep,
      fixedTimeSeconds: 3.25,
      coefficientPositionM: [0, 0, 0],
      centerM: [0, 0, 0],
      radiusM: 1,
    });
    if (!rejected) throw new Error('The rejected water candidate must remain present');
    expect(rejected.result).toMatchObject({
      ok: false,
      error: {
        code: 'buoyancy-candidate-rejected',
        detail: { kind: 'candidate', reason: 'water-publication', overlap: { entity: 3 } },
      },
    });
  });
});
