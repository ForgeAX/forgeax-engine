import { definePackageId } from '@forgeax/engine-pack/source';
import type {
  PhysicsBodyDynamics,
  PhysicsSensorOverlap,
  PhysicsSensorOverlaps,
  PhysicsSolverStepContext,
  PhysicsWorld,
} from '@forgeax/engine-physics';
import { PhysicsFixedError } from '@forgeax/engine-physics';
import { err, ok, sha256 } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeWaterSolverOutput,
  encodeWaterSolverSnapshot,
  processWaterBuoyancySolverTask,
  waterSolverBodySnapshot,
} from '../async-buoyancy.js';
import {
  sphericalCapVolumeM3,
  stepWaterBuoyancy,
  WATER_BUOYANCY_DEFAULTS,
  WaterBuoyancyCoefficientCache,
  type WaterBuoyancyFailure,
  type WaterBuoyancySettings,
  type WaterPontoon,
} from '../buoyancy.js';
import { type Vec3, type WaterBodySourceAsset, WaterQueryFlags } from '../contracts.js';
import { activeWaterFoamMaterialInput, type WaterFoamMaterialInput } from '../foam-input.js';
import { buildWaterPackOutputs } from '../pack-cook.js';
import { queryWaterParticle, WaterParticleQueryInstance } from '../particle-query.js';
import { WaterSystem } from '../system.js';
import { cookWaterAsset } from '../validate.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const source = (heightM = 0, type: 'lake' | 'river' = 'lake'): WaterBodySourceAsset => ({
  kind: 'water-body',
  type,
  baseHeightM: heightM,
  maxWaveHeightM: 0,
  overlapPriority: 0,
  shapeDilationM: 0,
  surfaceMaterialGuid: '00000000-0000-7000-8000-000000000001',
  flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
  collision: {
    type: type === 'river' ? 'river-prism' : 'polygon',
    enabled: true,
    ...(type === 'lake' ? { channelDepthM: 20 } : {}),
  },
  spline: {
    closed: type === 'lake',
    points: (type === 'river'
      ? [
          [-20, 0],
          [20, 0],
        ]
      : [
          [-20, -20],
          [20, -20],
          [20, 20],
          [-20, 20],
        ]
    ).map(([x, z]: readonly number[], inputKey) => ({
      inputKey,
      positionM: [x as number, heightM, z as number] as const,
      arriveTangentM: [type === 'river' ? 40 : 0, 0, 0] as const,
      leaveTangentM: [type === 'river' ? 40 : 0, 0, 0] as const,
      up: [0, 1, 0] as const,
      rollAngle: 0,
      angleUnit: 'degrees' as const,
      widthM: 20,
      depthM: 20,
      velocityMPerSec: 4,
      audioIntensity: 0,
    })),
  },
  queryFootprint: [
    [-20, -20],
    [20, -20],
    [20, 20],
    [-20, 20],
  ],
});
const pontoon = (centerM: Vec3 = [0, 0, 0], index = 0): WaterPontoon => ({
  id: `p${index}`,
  centerM,
  coefficientPositionM: centerM,
  anchor: 'socket',
  radiusM: 1,
  enabled: true,
});
const overlap = (entity: number): PhysicsSensorOverlap => ({
  entity,
  colliderId: `collider:${entity}`,
  generation: entity,
  bodyGeneration: entity,
  collisionGroups: 0xffff_ffff,
});
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
async function fixture(
  type: 'lake' | 'river' = 'lake',
  configureSource: (asset: WaterBodySourceAsset) => WaterBodySourceAsset = (asset) => asset,
) {
  const water = new WaterSystem(() => undefined);
  let mountVersion = 0;
  const mount = async (guid: string, heightM = 0) => {
    const output = (
      await buildWaterPackOutputs(
        { body: configureSource(source(heightM, type)) },
        {
          packageId: definePackageId('019a0000-0000-7000-8000-000000000399'),
        },
      )
    ).unwrap().body;
    if (output?.kind !== 'water-body') throw new Error('Missing cooked Water Body fixture');
    return water.mountBody(guid, String(++mountVersion), output).unwrap();
  };
  await mount('body/low');
  const snapshot = (guid: string) => {
    const value = water.snapshot(guid);
    if (!value) throw new Error(`Missing cooked Water snapshot ${guid}`);
    return value;
  };
  const applyBodyForceAtPoint = vi.fn<NonNullable<PhysicsWorld['applyBodyForceAtPoint']>>(() =>
    ok(undefined),
  );
  const applyBodyTorque = vi.fn<NonNullable<PhysicsWorld['applyBodyTorque']>>(() => ok(undefined));
  const physics: PhysicsWorld = { dispose() {}, applyBodyForceAtPoint, applyBodyTorque };
  const overlaps: PhysicsSensorOverlaps = {
    rootEntity: 1,
    rootGeneration: 7,
    completedStep: 40,
    current: [overlap(2)],
    entered: [],
    exited: [],
    stale: [],
  };
  const settings: WaterBuoyancySettings = { ...WATER_BUOYANCY_DEFAULTS, applyRiverForces: false };
  const input: Parameters<typeof stepWaterBuoyancy>[0] = {
    physics,
    water,
    dynamics,
    overlaps,
    coefficientCache: new WaterBuoyancyCoefficientCache(),
    settings,
    pontoons: [pontoon()],
    fixedDeltaSeconds: 1 / 60,
    fixedTimeSeconds: 3.25,
    resolveBody: (candidate) =>
      candidate.entity === 2
        ? ok(snapshot('body/low'))
        : candidate.entity === 3
          ? ok(snapshot('body/high'))
          : err<WaterBuoyancyFailure>({
              code: 'buoyancy-candidate-rejected',
              expected: 'a Water collider',
              hint: 'use current Water collision',
              detail: { kind: 'candidate', reason: 'water-publication', overlap: candidate },
            }),
  };
  return {
    water,
    mount,
    snapshot,
    input,
    applyBodyForceAtPoint,
    applyBodyTorque,
    step: (change: Partial<typeof input> = {}) =>
      stepWaterBuoyancy({ ...input, ...change }).unwrap(),
  };
}

async function solverFixture() {
  const f = await fixture();
  const encoded = encodeWaterSolverSnapshot({
    schema: 'forgeax-water-solver/3',
    nativePhysicsTimeSeconds: null,
    sourceDynamics: dynamics,
    overlaps: f.input.overlaps,
    pontoons: f.input.pontoons,
    coefficientResolution: new WaterBuoyancyCoefficientCache().resolve(
      f.input.pontoons,
      dynamics.localCenterOfMassM,
      true,
    ),
    settings: f.input.settings,
    bodies: [{ ...waterSolverBodySnapshot(f.snapshot('body/low'), [], 0), entity: 2 }],
  });
  const task = {
    taskId: 1,
    entity: 1,
    entityGeneration: 7,
    sourceStep: 40,
    solveStep: 41,
    referenceTimeSeconds: 9.25,
    ...encoded,
  };
  const context: PhysicsSolverStepContext = {
    solveStep: 41,
    deltaSeconds: 1 / 60,
    timestampSeconds: 0.5,
    getBodyDynamics: () => ok(dynamics),
    applyForceAtPoint: f.applyBodyForceAtPoint,
    applyTorque: f.applyBodyTorque,
    raycast: () => undefined,
    traceTerrainDown: () => undefined,
  };
  const { payload: _payload, ...identity } = task;
  const output = (bytes: Uint8Array) => ({
    ...identity,
    completedStep: 41,
    inputReleased: true as const,
    outputTimestampSeconds: 0.5,
    result: ok(bytes),
  });
  return { f, task, context, output };
}

describe('Water solver byte admission', () => {
  it('roundtrips unavailable local status and reordered completed bindings while retaining native base force', async () => {
    const { f, task, context, output } = await solverFixture();
    for (const completed of [false, true]) {
      const snapshot = JSON.parse(new TextDecoder().decode(task.payload));
      snapshot.nativePhysicsTimeSeconds = 0.5;
      const body = snapshot.bodies[0].body;
      const binding = {
        worldIdentity: 'world',
        bodyGuid: body.guid,
        bodyGeneration: body.sceneGeneration,
        maximumAgeSeconds: 0.25,
      };
      const domain = {
        resolution: 32,
        centerXZ: [0, 0],
        domainLengthM: 16,
        baseHeightM: 0,
        yawRadians: 0,
      };
      snapshot.bodies[0].localResidual = {
        binding,
        domain,
        ...(completed
          ? {
              field: {
                ...domain,
                binding: {
                  maximumAgeSeconds: 0.25,
                  bodyGeneration: body.sceneGeneration,
                  bodyGuid: body.guid,
                  worldIdentity: 'world',
                },
                recipeGuid: 'recipe',
                recipeVersion: 'v1',
                patchGeneration: 1,
                deviceGeneration: 1,
                sourceSequence: 1,
                sourcePhysicsStep: 40,
                timeSeconds: 0.5,
                simulationTimeSeconds: 0.5,
                completedFrame: 9,
                offset: [0, 0],
                size: [32, 32],
                receivers: [{ entity: 1, generation: 7 }],
                heightsM: Array(2048).fill(0.1),
              },
            }
          : {}),
      };
      const payloadText = JSON.stringify(snapshot),
        payload = new TextEncoder().encode(payloadText),
        snapshotHash = sha256(payloadText);
      const bytes = processWaterBuoyancySolverTask(
        { ...task, payload, snapshotHash },
        context,
      ).unwrap();
      const decoded = decodeWaterSolverOutput({ ...output(bytes), snapshotHash }).unwrap();
      const point = decoded.pontoons[0],
        candidate = point?.candidateRoster[0]?.result;
      expect(point?.buoyancyForceN[1]).toBeGreaterThan(0);
      expect(candidate?.ok).toBe(true);
      if (candidate?.ok) {
        expect(candidate.value.localResidual?.ok).toBe(completed);
        if (completed) expect(candidate.value.localResidual?.unwrap().heightM).toBeCloseTo(0.1);
        else
          expect(candidate.value.localResidual).toMatchObject({
            ok: false,
            error: { detail: { reason: 'not-completed' } },
          });
      }
      if (completed) {
        snapshot.bodies[0].localResidual.field.binding.invented = true;
        const changed = JSON.stringify(snapshot);
        expect(
          processWaterBuoyancySolverTask(
            { ...task, payload: new TextEncoder().encode(changed), snapshotHash: sha256(changed) },
            context,
          ).ok,
        ).toBe(false);
      }
    }
    expect(f.applyBodyForceAtPoint).toHaveBeenCalled();
  });

  it('rejects malformed, unversioned, nonfinite and oversized inputs before native force calls', async () => {
    const { f, task, context } = await solverFixture();
    const json = new TextDecoder().decode(task.payload);
    const source = JSON.parse(json);
    const inputs = [
      new Uint8Array([0xff]),
      new TextEncoder().encode('{'),
      new TextEncoder().encode(JSON.stringify({ ...source, schema: 'forgeax-water-solver/1' })),
      new TextEncoder().encode(JSON.stringify({ ...source, sourceDynamics: null })),
      new TextEncoder().encode(JSON.stringify({ ...source, settings: {} })),
      new TextEncoder().encode(
        JSON.stringify({ ...source, pontoons: Array(33).fill(source.pontoons[0]) }),
      ),
      new TextEncoder().encode(json.replace('"massKg":10', '"massKg":1e400')),
      new Uint8Array(16 * 1024 * 1024 + 1),
    ];
    for (const payload of inputs) {
      const snapshotHash = sha256(new TextDecoder().decode(payload));
      const result = processWaterBuoyancySolverTask({ ...task, payload, snapshotHash }, context);
      expect(result).toMatchObject({ ok: false, error: { code: 'fixed-input-invalid' } });
    }
    expect(f.applyBodyForceAtPoint).not.toHaveBeenCalled();
    expect(f.applyBodyTorque).not.toHaveBeenCalled();
  });

  it('rejects malformed output envelopes, Results, query sets and capacities without throwing', async () => {
    const { task, context, output } = await solverFixture();
    const valid = processWaterBuoyancySolverTask(task, context).unwrap();
    const wire = JSON.parse(new TextDecoder().decode(valid));
    expect(wire.schema).toBe('forgeax-water-solver-output/2');
    const mutate = (change: (value: typeof wire) => void) => {
      const copy = JSON.parse(JSON.stringify(wire));
      change(copy);
      return new TextEncoder().encode(JSON.stringify(copy));
    };
    const inputs = [
      new Uint8Array([0xff]),
      new TextEncoder().encode('{'),
      mutate((value) => {
        value.schema = 'forgeax-water-solver-output/0';
      }),
      mutate((value) => {
        value.schema = 'forgeax-water-solver-output/1';
      }),
      new TextEncoder().encode(JSON.stringify({ ok: true, value: null })),
      mutate((value) => {
        value.result = { ok: true, value: null };
      }),
      mutate((value) => {
        value.result.value.pontoons[0].candidateRoster[0].result.value.valid = {
          waterQueryFields: 'depth',
        };
      }),
      mutate((value) => {
        value.result.value.pontoons[0].candidateRoster[0].result.value.valid = {
          waterQueryFields: ['unknown'],
        };
      }),
      mutate((value) => {
        value.result.value.pontoons[0].candidateRoster[0].result.value.localResidual = {
          invented: true,
        };
      }),
      mutate((value) => {
        const sample = value.result.value.pontoons[0].candidateRoster[0].result.value;
        sample.localResidual = {
          ok: true,
          value: {
            worldIdentity: 'world',
            bodyGuid: sample.bodyGuid,
            bodyGeneration: sample.bodyGeneration,
            recipeGuid: 'recipe',
            recipeVersion: 'v1',
            patchGeneration: 1,
            deviceGeneration: 1,
            sourceSequence: 1,
            sourcePhysicsStep: 41,
            completedFrame: 1,
            queryPhysicsStep: 40,
            timeSeconds: 0.5,
            simulationTimeSeconds: 0.5,
            ageSeconds: 0,
            maximumAgeSeconds: 0.25,
            queryPhysicsTimeSeconds: 0.5,
            heightM: 0.1,
            weight: 1,
          },
        };
      }),
      mutate((value) => {
        value.result.value.pontoons = Array(33).fill(value.result.value.pontoons[0]);
      }),
      mutate((value) => {
        value.result.value.bodyForceResult = { ok: false, error: { code: 'invented', detail: {} } };
      }),
      mutate((value) => {
        value.result.value.rootEntity++;
      }),
      mutate((value) => {
        value.result.value.rootGeneration++;
      }),
      mutate((value) => {
        value.result.value.physicsStep++;
      }),
      mutate((value) => {
        value.result.value.dynamics.completedStep++;
      }),
      mutate((value) => {
        delete value.result.value.splashWakeEvents[0].contact;
      }),
      mutate((value) => {
        value.result.value.splashWakeEvents[0].sourcePhysicsStep++;
      }),
      mutate((value) => {
        value.result.value.splashWakeEvents[0].bodyGeneration++;
      }),
      mutate((value) => {
        value.result.value.splashWakeEvents[0].queryTimeSeconds++;
      }),
      mutate((value) => {
        value.result.value.splashWakeEvents.push(value.result.value.splashWakeEvents[0]);
      }),
      mutate((value) => {
        value.result.value.splashWakeEvents[0].contact.radiusM = -1;
      }),
      mutate((value) => {
        value.result.value.splashWakeEvents[0].contact.positionM[1]++;
      }),
      new TextEncoder().encode(
        new TextDecoder().decode(valid).replace('"massKg":10', '"massKg":1e400'),
      ),
      new Uint8Array(16 * 1024 * 1024 + 1),
    ];
    for (const payload of inputs)
      expect(decodeWaterSolverOutput(output(payload))).toMatchObject({
        ok: false,
        error: { code: 'fixed-input-invalid' },
      });
  });

  it.each([
    ['fixed-backend-failed', 'rebuild-required'],
    ['fixed-body-missing', 'await-native-sync'],
  ] as const)('round-trips real Worker results and structured %s recovery', async (code, recovery) => {
    const { f, task, context, output } = await solverFixture();
    const failure = new PhysicsFixedError(code, {
      entity: 1,
      reason: 'native force rejected',
      recovery,
    });
    f.applyBodyForceAtPoint.mockReturnValue(err(failure));
    const payload = processWaterBuoyancySolverTask(task, context).unwrap();
    const result = decodeWaterSolverOutput(output(payload)).unwrap();
    const point = result.pontoons[0];
    const candidate = point?.candidateRoster[0]?.result.unwrap();
    if (!point || !candidate) throw new Error('Missing completed Water query fixture');
    expect(candidate.valid).toBeInstanceOf(Set);
    expect(candidate.valid.has('immersion')).toBe(true);
    const restored = point.result;
    expect(restored).toMatchObject({
      ok: false,
      error: {
        code: failure.code,
        detail: failure.detail,
        expected: failure.expected,
        hint: failure.hint,
      },
    });
    if (!restored.ok) expect(restored.error).toBeInstanceOf(PhysicsFixedError);
    expect(() => restored.unwrap()).toThrow(PhysicsFixedError);
    expect(() => result.bodyForceResult.unwrap()).toThrow(PhysicsFixedError);
    expect(result.bodyTorqueResult.unwrap()).toBeUndefined();
    for (const deniedRecovery of [
      'invented',
      ...(code === 'fixed-backend-failed' ? ['await-native-sync'] : []),
    ]) {
      const malformed = new TextDecoder()
        .decode(payload)
        .replaceAll(`"recovery":"${recovery}"`, `"recovery":"${deniedRecovery}"`);
      expect(decodeWaterSolverOutput(output(new TextEncoder().encode(malformed)))).toMatchObject({
        ok: false,
        error: { code: 'fixed-input-invalid' },
      });
    }
  });
});

describe('synchronous buoyancy owner', () => {
  it('captures the water-plane circle and point-relative velocity before integration', async () => {
    const f = await fixture();
    const centerM: [number, number, number] = [2, 0.6, 0];
    const step = f.step({
      dynamics: {
        ...dynamics,
        linearVelocityMps: [3, 0, 0],
        angularVelocityRadps: [1, 2, 3],
      },
      pontoons: [pontoon(centerM)],
    });
    expect(step.splashWakeEvents).toMatchObject([
      {
        rootEntity: 1,
        rootGeneration: 7,
        sourcePhysicsStep: 41,
        queryTimeSeconds: 3.25,
        fixedDeltaSeconds: 1 / 60,
        positionM: [2, 0.6, 0],
        contact: {
          kind: 'water-plane-intersection',
          positionM: [2, 0, 0],
          radiusM: 0.8,
          relativeVelocityMps: [3, 6, -8],
        },
      },
    ]);
    centerM[0] = 99;
    expect(step.splashWakeEvents[0]?.positionM).toEqual([2, 0.6, 0]);
    expect(Object.isFrozen(step.splashWakeEvents[0])).toBe(true);
  });

  it.each([
    { centerY: 1, reason: 'tangent' },
    { centerY: -1, reason: 'tangent' },
    { centerY: -2, reason: 'submerged' },
    { centerY: 3, reason: 'exited' },
  ])('does not publish a foam contact for $reason at center Y $centerY', async ({
    centerY,
    reason,
  }) => {
    const f = await fixture();
    const previousWaterState = {
      inWater: true,
      bodyGuid: 'body/low',
      bodyGeneration: f.snapshot('body/low').sceneGeneration,
    };
    const step = f.step({ pontoons: [{ ...pontoon([0, centerY, 0]), previousWaterState }] });
    expect(step.splashWakeEvents).toMatchObject([{ contact: { kind: 'none', reason } }]);
  });

  it('captures water-relative flow and keeps a dry pontoon without a prior wet sample silent', async () => {
    const f = await fixture('river');
    expect(f.step().splashWakeEvents).toMatchObject([
      { contact: { kind: 'water-plane-intersection', relativeVelocityMps: [-4, 0, 0] } },
    ]);
    expect(f.step({ pontoons: [pontoon([0, 3, 0])] }).splashWakeEvents).toEqual([]);
  });

  it('freezes wet edges from each input prior state, including reused input and exits', async () => {
    const f = await fixture();
    const dryInput = { ...pontoon(), previousWaterState: { inWater: false } };
    const first = f.step({ pontoons: [dryInput] });
    expect(first.splashWakeEvents).toMatchObject([
      { phase: 'entered', sourcePhysicsStep: 41, bodyGuid: 'body/low', positionM: [0, 0, 0] },
    ]);
    expect(f.step({ pontoons: [dryInput] }).splashWakeEvents).toEqual(first.splashWakeEvents);
    const previousWaterState = {
      inWater: true,
      bodyGuid: 'body/low',
      bodyGeneration: f.snapshot('body/low').sceneGeneration,
    };
    expect(
      f.step({ pontoons: [{ ...pontoon(), previousWaterState }] }).splashWakeEvents,
    ).toMatchObject([{ phase: 'wake' }]);
    expect(
      f.step({ pontoons: [{ ...pontoon([0, 3, 0]), previousWaterState }] }).splashWakeEvents,
    ).toMatchObject([{ phase: 'exited', bodyGuid: 'body/low', positionM: [0, 3, 0] }]);
    expect(
      f.step({ pontoons: [{ ...pontoon([0, 3, 0]), enabled: false, previousWaterState }] })
        .splashWakeEvents,
    ).toEqual([]);
  });

  it('lets the async negative shore blend extrapolate before the acceleration cap', async () => {
    const f = await fixture('river');
    const step = f.step({
      solverSafe: true,
      fixedDeltaSeconds: 0.1,
      pontoons: [pontoon([0, 0, 7.5])],
      settings: {
        ...f.input.settings,
        applyRiverForces: true,
        riverVelocityStrength: 0,
        riverShoreFactor: -0.2,
        riverTraversalPathWidthM: 3,
        maxLateralAccelerationMps2: 3,
        alwaysAllowLateralPush: true,
      },
    });
    expect(step.riverAccelerationMps2).toEqual([0, 0, -3]);
  });

  it('carries the GT cached coefficient solve into solver execution without recomputing animated sockets', async () => {
    const f = await fixture();
    const cache = new WaterBuoyancyCoefficientCache();
    const original = [pontoon([-1, 0, 0], 0), pontoon([1, 0, 0], 1)];
    const solved = cache.resolve(original, [0, 0, 0], false);
    const animated = original.map((value, index) => ({
      ...value,
      centerM: [index + 5, 0, 0] as Vec3,
      coefficientPositionM: [index + 5, 0, 0] as Vec3,
    }));
    const coefficientResolution = cache.resolve(animated, [0.25, 0, 0], false);
    expect(coefficientResolution.hit).toBe(true);
    expect(coefficientResolution.result).toBe(solved.result);
    const encoded = encodeWaterSolverSnapshot({
      schema: 'forgeax-water-solver/3',
      nativePhysicsTimeSeconds: null,
      sourceDynamics: dynamics,
      overlaps: f.input.overlaps,
      pontoons: animated,
      coefficientResolution,
      settings: f.input.settings,
      bodies: [{ ...waterSolverBodySnapshot(f.snapshot('body/low'), [], 0), entity: 2 }],
    });
    const context: PhysicsSolverStepContext = {
      solveStep: 41,
      deltaSeconds: 1 / 60,
      timestampSeconds: 0.5,
      getBodyDynamics: () => ok({ ...dynamics, localCenterOfMassM: [0.25, 0, 0] }),
      applyForceAtPoint: f.applyBodyForceAtPoint,
      applyTorque: f.applyBodyTorque,
      raycast: () => undefined,
      traceTerrainDown: () => undefined,
    };
    const task = {
      taskId: 1,
      entity: 1,
      entityGeneration: 7,
      sourceStep: 40,
      solveStep: 41,
      referenceTimeSeconds: 9.25,
      ...encoded,
    };
    const bytes = processWaterBuoyancySolverTask(task, context);
    expect(bytes.ok, JSON.stringify(bytes)).toBe(true);
    const { payload: _payload, ...identity } = task;
    const result = decodeWaterSolverOutput({
      ...identity,
      completedStep: 41,
      inputReleased: true,
      outputTimestampSeconds: 0.5,
      result: bytes,
    }).unwrap();
    expect(result.coefficientCache).toEqual({ enabledMask: 3, hit: true });
    expect(result.coefficientSolve).toEqual(solved.result.unwrap());
    expect(result.pontoons.map((value) => value.coefficient)).toEqual([0.5, 0.5]);
  });

  it('keeps all-disabled participants inactive without queries or native requests', async () => {
    const f = await fixture('river');
    const query = vi.spyOn(f.water, 'queryBody');
    const step = f.step({
      pontoons: [{ ...pontoon(), enabled: false }],
      settings: { ...f.input.settings, applyRiverForces: true, applyDrag: true },
    });
    expect(step.coefficientSolve).toMatchObject({
      sourceSuccess: false,
      sourceStatus: 'not-invoked',
      branch: 'inactive',
    });
    expect(step.coefficientCache).toEqual({ enabledMask: 0, hit: false });
    expect(query).not.toHaveBeenCalled();
    expect(f.applyBodyForceAtPoint).not.toHaveBeenCalled();
    expect(f.applyBodyTorque).not.toHaveBeenCalled();
  });
  it('reuses each enabled-mask solve after native COM changes and toggling away and back', async () => {
    const f = await fixture();
    const pontoons = [pontoon([-2, 0, 0]), pontoon([4, 0, 0], 1)];
    const first = f.step({ pontoons });
    const moved = { ...dynamics, localCenterOfMassM: [1, 0, 0] as Vec3 };
    const second = f.step({ pontoons, dynamics: moved });
    expect(second.pontoons.map((p) => p.coefficient)).toEqual(
      first.pontoons.map((p) => p.coefficient),
    );
    expect(
      f
        .step({
          pontoons: [
            pontoons[0] as WaterPontoon,
            { ...(pontoons[1] as WaterPontoon), enabled: false },
          ],
          dynamics: moved,
        })
        .pontoons.map((p) => p.coefficient),
    ).toEqual([1, 0]);
    const restored = f.step({ pontoons, dynamics: moved });
    expect(restored.pontoons.map((p) => p.coefficient)).toEqual(
      first.pontoons.map((p) => p.coefficient),
    );
    expect(restored.coefficientSolve.centerOfMassM).toEqual([0, 0, 0]);
  });

  it('queries a sloped River with the key sampled at the pontoon center', async () => {
    const f = await fixture('river', (asset) => ({
      ...asset,
      spline: {
        ...asset.spline,
        points: asset.spline.points.map((p, i) => ({
          ...p,
          interpolationMode: 'linear',
          positionM: i === 0 ? [0, 0, 0] : [10, 5, 0],
        })),
      },
    }));
    const trace = f.step({ pontoons: [pontoon([5, 2.5, 0])] }).pontoons[0];
    expect(trace?.candidateRoster[0]).toMatchObject({
      result: { ok: true, value: { splineKey: 0.5 } },
    });
    expect(trace?.waterYM).toBeCloseTo(2.5, 8);
  });
  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects native mass %s before queries or force admission', async (massKg) => {
    const f = await fixture();
    expect(stepWaterBuoyancy({ ...f.input, dynamics: { ...dynamics, massKg } })).toMatchObject({
      ok: false,
      error: { code: 'buoyancy-config-invalid', detail: { reason: 'invalid-root-mass', massKg } },
    });
    expect(f.applyBodyForceAtPoint).not.toHaveBeenCalled();
    expect(f.applyBodyTorque).not.toHaveBeenCalled();
  });

  it.each([
    39, 41,
  ])('rejects a roster from completed step %i against dynamics step 40', async (completedStep) => {
    const f = await fixture();
    expect(
      stepWaterBuoyancy({ ...f.input, overlaps: { ...f.input.overlaps, completedStep } }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'buoyancy-config-invalid',
        detail: {
          reason: 'overlap-step-mismatch',
          dynamicsCompletedStep: 40,
          overlapCompletedStep: completedStep,
        },
      },
    });
    expect(f.applyBodyForceAtPoint).not.toHaveBeenCalled();
    expect(f.applyBodyTorque).not.toHaveBeenCalled();
  });

  it.each([
    4, 8, 16, 32,
  ])('preserves flat-water hull support capacity for %i calibrated weighted points', async (count) => {
    const f = await fixture();
    const supports = Array.from({ length: count }, (_, index) => ({
      ...pontoon(
        [-6 + (Math.floor(index / 2) * 12) / (count / 2 - 1), -0.9, index % 2 === 0 ? -1.6 : 1.6],
        index,
      ),
      radiusM: 1.5,
    }));
    const result = f.step({
      pontoons: supports,
      dynamics: { ...dynamics, massKg: 13066.65 },
      settings: { ...f.input.settings, buoyancyCoefficientNPerM3: 9810, maxBuoyantForceN: 300000 },
    });
    expect(result.coefficientSolve.diagnostics).toEqual([]);
    expect(result.pontoons.reduce((sum, trace) => sum + trace.coefficient, 0)).toBeCloseTo(1, 10);
    const force = result.pontoons.reduce((sum, trace) => sum + trace.buoyancyForceN[1], 0);
    expect(force).toBeCloseTo(sphericalCapVolumeM3(1.5, 2.4) * 9810, 6);
    expect(force / (13066.65 * 9.81)).toBeGreaterThan(0.9);
    expect(force / (13066.65 * 9.81)).toBeLessThan(1.1);
  });

  it.each([
    1, 4, 16,
  ])('computes complete numerical traces and native requests for %i supports', async (count) => {
    const f = await fixture();
    const positions: Vec3[] =
      count === 1
        ? [[0, 0, 0]]
        : (count === 4 ? [-1, 1] : [-3, -1, 1, 3]).flatMap((x) =>
            (count === 4 ? [-1, 1] : [-3, -1, 1, 3]).map((z) => [x, 0, z] as Vec3),
          );
    const step = f.step({ pontoons: positions.map(pontoon) });
    expect(step.pontoons).toHaveLength(count);
    expect(step.coefficientSolve.diagnostics).toEqual([]);
    for (const trace of step.pontoons) {
      expect(trace).toMatchObject({
        physicsStep: 41,
        completedOverlapStep: 40,
        fixedTimeSeconds: 3.25,
        selectedBodyGuid: 'body/low',
        waterYM: 0,
        immersionM: 1,
        coefficient: 1 / count,
        sprungMassKg: 10 / count,
        rampCoefficientNPerM3: 1000,
        inWater: true,
        result: { ok: true },
      });
      expect(trace.queryPointM).toEqual([trace.centerM[0], -2, trace.centerM[2]]);
      expect(trace.volumeM3).toBeCloseTo((2 * Math.PI) / 3, 12);
      expect(trace.buoyancyForceN[1]).toBeCloseTo((2000 * Math.PI) / 3 / count, 10);
      expect(trace.applicationPointM).toEqual(trace.centerM);
    }
    expect(step.forceEvents).toHaveLength(count);
    expect(f.applyBodyForceAtPoint).toHaveBeenCalledTimes(count + 1);
    expect(step.pontoons.reduce((sum, p) => sum + p.buoyancyForceN[1], 0)).toBeCloseTo(
      (2000 * Math.PI) / 3,
      10,
    );
  });

  it('caps each damped ramp force before multiplying the sprung fraction and applies at the sphere center', async () => {
    const f = await fixture();
    const points: Vec3[] = [
      [-1, 0, -1],
      [1, 0, -1],
      [-1, 0, 1],
      [1, 0, 1],
    ];
    const settings = {
      ...f.input.settings,
      rampMinSpeedMps: 0,
      rampMaxSpeedMps: 20,
      rampMax: 3,
      dampingNPerMps: 10,
      dampingNPerMpsSquared: 2,
      maxBuoyantForceN: 400,
    };
    const step = f.step({
      settings,
      pontoons: points.map(pontoon),
      dynamics: { ...dynamics, linearVelocityMps: [10, 3, 0] },
    });
    for (const trace of step.pontoons) {
      expect(trace.rampCoefficientNPerM3).toBe(2000);
      expect(trace.dampingN).toBe(-48);
      expect(trace.preCapForceN).toBeCloseTo((4000 * Math.PI) / 3 - 48, 9);
      expect(trace.postCapForceN).toBe(400);
      expect(trace.buoyancyForceN).toEqual([0, 100, 0]);
      [-trace.centerM[2] * 100, 0, trace.centerM[0] * 100].forEach((value, axis) => {
        expect(trace.torqueNm[axis]).toBeCloseTo(value, 10);
      });
    }
    const down = f.step({ settings, dynamics: { ...dynamics, linearVelocityMps: [0, -3, 0] } })
      .pontoons[0];
    expect(down?.dampingN).toBeCloseTo(0, 10);
    expect(down?.postCapForceN).toBe(400);
    const up = f.step({ settings, dynamics: { ...dynamics, linearVelocityMps: [0, 100, 0] } })
      .pontoons[0];
    expect(up?.postCapForceN).toBe(0);
    expect(sphericalCapVolumeM3(1, -2)).toBe(0);
    expect(sphericalCapVolumeM3(1, 8)).toBeCloseTo((4 * Math.PI) / 3, 12);
  });

  it('selects maximum query immersion in roster order, retaining rejected and stale candidates', async () => {
    const f = await fixture();
    await f.mount('body/high', 1);
    const high = overlap(3),
      nonWater = overlap(4),
      stale = overlap(5);
    const overlaps = { ...f.input.overlaps, current: [nonWater, overlap(2), high], stale: [stale] };
    const trace = f.step({ overlaps }).pontoons[0];
    expect(trace?.selectedBodyGuid).toBe('body/high');
    expect(trace?.candidateRoster.map((c) => c.isInWater)).toEqual([false, true, true, false]);
    expect(trace?.candidateRoster[3]).toMatchObject({
      result: { ok: false, error: { code: 'buoyancy-candidate-rejected' } },
    });
    await f.mount('body/high', 0);
    expect(
      f.step({ overlaps: { ...overlaps, current: [high, overlap(2)] } }).pontoons[0]
        ?.selectedBodyGuid,
    ).toBe('body/high');
    expect(f.step({ overlaps: { ...overlaps, current: [], stale: [] } }).pontoons[0]).toMatchObject(
      { inWater: false, buoyancyForceN: [0, 0, 0] },
    );
  });

  it('honors query exclusion and disabled pontoons without substituting nearest Water', async () => {
    const f = await fixture();
    f.water
      .setExclusionVolumes('body/low', [
        { entity: 9, centerM: [0, -1, 0], halfExtentsM: [2, 4, 2], worldMatrixM: identity },
      ])
      .unwrap();
    const excluded = f.step().pontoons[0];
    expect(excluded?.candidateRoster[0]).toMatchObject({
      isInWater: false,
      result: { ok: true, value: { excluded: true } },
    });
    expect(excluded?.buoyancyForceN).toEqual([0, 0, 0]);
    const enabled = pontoon([1, 0, 0]),
      disabled = { ...pontoon([-1, 0, 0], 1), enabled: false };
    const step = f.step({
      pontoons: [enabled, disabled],
      coefficientCache: new WaterBuoyancyCoefficientCache(),
    });
    expect(step.pontoons[1]).toMatchObject({
      coefficient: 0,
      inWater: false,
      buoyancyForceN: [0, 0, 0],
    });
  });

  it('uses only the velocity pontoon for River acceleration and actual mass/inertia for drag', async () => {
    const f = await fixture('river');
    const settings = {
      ...f.input.settings,
      applyRiverForces: true,
      riverShoreFactor: 0,
      riverVelocityStrength: 0.5,
      maxRiverAccelerationMps2: 3,
      applyDrag: true,
      linearDragCoefficient: 20,
      quadraticDragCoefficient: 0.01,
      angularDragPerSecond: 2,
    };
    const step = f.step({
      settings,
      dynamics: { ...dynamics, linearVelocityMps: [2, 5, 0], angularVelocityRadps: [1, 2, 3] },
    });
    expect(step.riverAccelerationMps2).toEqual([3, 0, 0]);
    expect(step.dragAccelerationMps2[0]).toBeCloseTo(-1.445184, 9);
    expect(step.dragAccelerationMps2[1]).toBeCloseTo(0, 10);
    expect(step.angularAccelerationRadps2).toEqual([-2, -4, -6]);
    expect(step.angularDragTorqueNm).toEqual([-4, -12, -24]);
    expect(f.applyBodyForceAtPoint.mock.calls.at(-1)?.[0]).toMatchObject({
      forceN: [expect.closeTo(15.54816, 7), 0, 0],
      pointM: dynamics.centerOfMassM,
    });
    const stopped = f.step({ settings, dynamics: { ...dynamics, linearVelocityMps: [5, 0, 0] } });
    expect(stopped.riverAccelerationMps2).toEqual([0, 0, 0]);
    for (const velocityPontoonIndex of [9, 0.5]) {
      expect(
        stepWaterBuoyancy({ ...f.input, settings: { ...settings, velocityPontoonIndex } }),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'buoyancy-config-invalid',
          detail: { kind: 'settings', reason: 'velocity-pontoon-index', velocityPontoonIndex },
        },
      });
    }
  });

  it('retains successful singular-axis diagnostics in the completed numerical trace', async () => {
    const f = await fixture();
    const step = f.step({
      pontoons: Array.from({ length: 3 }, (_, i) => ({
        ...pontoon([i, 0, 0], i),
        coefficientPositionM: [0.0001, 0, 0],
      })),
    });
    expect(step.coefficientSolve.diagnostics).toEqual([
      { code: 'sprung-axis-singular', axis: 'x', determinantM2: 0, thresholdM2: 1e-14 },
    ]);
    expect(step.pontoons.map((p) => p.coefficient)).toEqual(
      Array(3).fill(Math.fround(1 / 3 - 0.0001)),
    );
  });

  it('does not select a zero-immersion River candidate or apply River acceleration', async () => {
    const f = await fixture('river');
    const step = f.step({
      pontoons: [pontoon([0, 2, 0])],
      settings: { ...f.input.settings, applyRiverForces: true },
    });
    expect(step.pontoons[0]).toMatchObject({
      candidateRoster: [{ isInWater: false, result: { ok: true, value: { immersionM: 0 } } }],
      inWater: false,
      buoyancyForceN: [0, 0, 0],
    });
    expect(step.pontoons[0]?.selectedBodyGuid).toBeUndefined();
    expect(step.riverAccelerationMps2).toEqual([0, 0, 0]);
  });
});

describe('basic CPU DI and independent foam inputs', () => {
  it('queries the exact specified Body generation, flags and time, and refuses GPU simulation', async () => {
    const f = await fixture();
    await f.mount('body/high', 4);
    const body = f.snapshot('body/low');
    const instance = new WaterParticleQueryInstance();
    instance
      .tick(f.water, {
        tick: 7,
        bodyGuid: body.guid,
        bodyGeneration: body.sceneGeneration,
        systemPositionM: [0, 0, 0],
        timeSeconds: 7.25,
      })
      .unwrap();
    const request = {
      simulation: 'cpu' as const,
      instance,
      tick: 7,
      bodyGuid: body.guid,
      bodyGeneration: body.sceneGeneration,
      positionM: [0, -1, 0] as const,
      timeSeconds: 7.25,
    };
    const sample = queryWaterParticle(f.water, request).unwrap();
    expect(sample).toMatchObject({
      simulation: 'cpu',
      bodyGuid: 'body/low',
      bodyGeneration: body.sceneGeneration,
      timeSeconds: 7.25,
      valid: true,
      waterDepthM: 20,
      depthSource: 'system-instance',
      planeNormalYUp: [0, 1, 0],
      sample: { surfaceM: [0, 0, 0], excluded: false },
    });
    expect(sample.queryFlags).toBe(
      WaterQueryFlags.ComputeLocation |
        WaterQueryFlags.ComputeNormal |
        WaterQueryFlags.ComputeVelocity |
        WaterQueryFlags.IncludeWaves |
        WaterQueryFlags.SimpleWaves,
    );
    expect(sample.sample?.valid.has('depth')).toBe(false);
    expect(sample.sample?.depthM).toBeUndefined();
    expect(
      queryWaterParticle(f.water, { ...request, bodyGeneration: body.sceneGeneration + 1 }),
    ).toMatchObject({ ok: false, error: { code: 'stale-generation' } });
    expect(queryWaterParticle(f.water, { ...request, simulation: 'gpu' })).toMatchObject({
      ok: false,
      error: {
        code: 'water-gpu-particle-query-unsupported',
        detail: { simulation: 'gpu', bodyGuid: 'body/low' },
      },
    });
  });

  it('keeps disabled depth and the plane normal independent from an accepted full-wave sample', async () => {
    const waveGuid = '00000000-0000-7000-8000-000000000009';
    const waves = cookWaterAsset({
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.5, steepness: 0.2 }],
      },
      depthMaskM: 4,
      maxWaveHeightM: 0.5,
      timeSource: 'fixed-step',
    }).unwrap();
    const water = new WaterSystem(
      () => undefined,
      () => [
        {
          guid: waveGuid,
          field: 'waveSetGuid',
          kind: 'water-wave-set',
          status: 'valid',
          payload: waves,
        },
      ],
    );
    const output = (
      await buildWaterPackOutputs(
        { body: { ...source(), waveSetGuid: waveGuid, maxWaveHeightM: 0.5 } },
        {
          packageId: definePackageId('019a0000-0000-7000-8000-000000000399'),
          readByGuid: async () => ok(waves),
        },
      )
    ).unwrap().body;
    if (output?.kind !== 'water-body') throw new Error('Missing full-wave Body fixture');
    const body = water.mountBody('body/waves', '1', output).unwrap();
    const instance = new WaterParticleQueryInstance();
    const request = {
      simulation: 'cpu' as const,
      instance,
      tick: 1,
      bodyGuid: body.guid,
      bodyGeneration: body.sceneGeneration,
      positionM: [1, -1, 0] as Vec3,
      timeSeconds: 0,
      includeDepth: false,
      simpleWaves: false,
    };
    const result = queryWaterParticle(water, request).unwrap();
    expect(result).toMatchObject({
      valid: true,
      depthSource: 'disabled',
      waterDepthM: 0,
      planeNormalYUp: [0, 1, 0],
      sample: { planeNormalYUp: [0, 1, 0] },
    });
    expect(result.sample?.depthM).toBeGreaterThan(20);
    expect(result.sample?.valid.has('depth')).toBe(true);
    expect(Math.abs(result.sample?.normalYUp?.[0] ?? 0)).toBeGreaterThan(0.01);
    expect(result.sample?.normalYUp).not.toEqual(result.planeNormalYUp);
    const noWaves = queryWaterParticle(water, { ...request, includeWaves: false }).unwrap();
    expect(noWaves.sample?.valid.has('depth')).toBe(false);
    expect(noWaves.sample?.depthM).toBeUndefined();
    expect(noWaves.sample?.normalYUp).toEqual(noWaves.planeNormalYUp);
  });

  it('implements ExecuteQuery defaults and the independent instance/particle/disabled depth branches', async () => {
    const f = await fixture('river', (asset) => ({
      ...asset,
      spline: {
        ...asset.spline,
        points: asset.spline.points.map((p, i) => ({
          ...p,
          interpolationMode: 'linear',
          depthM: i === 0 ? 2 : 10,
        })),
      },
    }));
    const body = f.snapshot('body/low'),
      instance = new WaterParticleQueryInstance();
    const query = vi.spyOn(f.water, 'queryBody');
    const request = {
      simulation: 'cpu' as const,
      instance,
      tick: 12,
      bodyGuid: body.guid,
      bodyGeneration: body.sceneGeneration,
      positionM: [10, 0, 0] as Vec3,
      timeSeconds: 4,
    };
    expect(queryWaterParticle(f.water, { ...request, executeQuery: false }).unwrap()).toMatchObject(
      {
        valid: false,
        queryFlags: 0,
        surfacePositionM: [0, 0, 0],
        planePositionM: [0, 0, 0],
        planeNormalYUp: [0, 1, 0],
        waterVelocityMps: [0, 0, 0],
        waterDepthM: 0,
        excluded: false,
      },
    );
    expect(query).not.toHaveBeenCalled();
    expect(
      queryWaterParticle(f.water, {
        ...request,
        bodyGuid: undefined,
        bodyGeneration: undefined,
      }).unwrap().valid,
    ).toBe(false);
    instance
      .tick(f.water, {
        tick: 12,
        bodyGuid: body.guid,
        bodyGeneration: body.sceneGeneration,
        systemPositionM: [-10, 0, 0],
        timeSeconds: 4,
      })
      .unwrap();
    expect(queryWaterParticle(f.water, request).unwrap()).toMatchObject({
      valid: true,
      waterDepthM: 4,
      depthSource: 'system-instance',
      systemDepth: { sourceTick: 12, depthM: 4 },
    });
    expect(
      queryWaterParticle(f.water, {
        ...request,
        depthQueryMode: 'particle',
        includeWaves: false,
      }).unwrap(),
    ).toMatchObject({ waterDepthM: 8, depthSource: 'particle' });
    expect(queryWaterParticle(f.water, { ...request, includeDepth: false }).unwrap()).toMatchObject(
      { waterDepthM: 0, depthSource: 'disabled' },
    );
    expect(
      query.mock.calls.filter(([, value]) => value.flags === WaterQueryFlags.ComputeDepth),
    ).toHaveLength(1);
    instance
      .tick(f.water, {
        tick: 12,
        bodyGuid: body.guid,
        bodyGeneration: body.sceneGeneration,
        systemPositionM: [-10, 0, 0],
        timeSeconds: 4,
      })
      .unwrap();
    expect(
      query.mock.calls.filter(([, value]) => value.flags === WaterQueryFlags.ComputeDepth),
    ).toHaveLength(1);
    expect(queryWaterParticle(f.water, { ...request, tick: 13 })).toMatchObject({
      ok: false,
      error: {
        code: 'water-particle-query-context-unavailable',
        detail: { reason: 'tick-mismatch' },
      },
    });
    instance
      .tick(f.water, {
        tick: 13,
        bodyGuid: body.guid,
        bodyGeneration: body.sceneGeneration,
        systemPositionM: [10, 0, 0],
        timeSeconds: 5,
        evaluateSystemDepthPerFrame: false,
      })
      .unwrap();
    expect(
      queryWaterParticle(f.water, { ...request, tick: 13, timeSeconds: 5 }).unwrap().waterDepthM,
    ).toBe(4);
    instance
      .tick(f.water, {
        tick: 14,
        bodyGuid: body.guid,
        bodyGeneration: body.sceneGeneration,
        systemPositionM: [10, 0, 0],
        timeSeconds: 6,
        evaluateSystemDepth: false,
      })
      .unwrap();
    expect(
      queryWaterParticle(f.water, { ...request, tick: 14, timeSeconds: 6 }).unwrap(),
    ).toMatchObject({ waterDepthM: 0, systemDepth: { evaluated: false } });
    instance
      .tick(f.water, {
        tick: 15,
        bodyGuid: body.guid,
        bodyGeneration: body.sceneGeneration,
        systemPositionM: [10, 0, 0],
        timeSeconds: 7,
        evaluateSystemDepthPerFrame: false,
      })
      .unwrap();
    expect(
      queryWaterParticle(f.water, { ...request, tick: 15, timeSeconds: 7 }).unwrap(),
    ).toMatchObject({ waterDepthM: 8, systemDepth: { evaluated: true, sourceTick: 15 } });
  });

  it('retires disabled dynamic/Baked bindings while preserving all static inputs independently', () => {
    const input: WaterFoamMaterialInput = {
      sourceGeneration: 7,
      staticTexture: { guid: 'static', version: 2 },
      staticNormalTexture: { guid: 'normal', version: 3 },
      volumeNoiseTexture: { guid: 'noise', version: 4 },
      fluidRt: { targetKey: 'fluid', simulationGeneration: 11 },
      bakedRef: { guid: 'baked', assetGeneration: 12 },
      materialSwitches: {
        waterOceanFoam: true,
        fluidSimulationFoam: false,
        waterBakedSimulation: false,
      },
    };
    const staticOnly = activeWaterFoamMaterialInput(input);
    expect(staticOnly).not.toHaveProperty('fluidRt');
    expect(staticOnly).not.toHaveProperty('bakedRef');
    expect(staticOnly.staticTexture).toBe(input.staticTexture);
    expect(staticOnly.staticNormalTexture).toBe(input.staticNormalTexture);
    expect(staticOnly.volumeNoiseTexture).toBe(input.volumeNoiseTexture);
    expect(
      activeWaterFoamMaterialInput({
        ...input,
        materialSwitches: {
          waterOceanFoam: false,
          fluidSimulationFoam: true,
          waterBakedSimulation: true,
        },
      }),
    ).toMatchObject({
      fluidRt: input.fluidRt,
      bakedRef: input.bakedRef,
      staticTexture: input.staticTexture,
    });
  });
});
