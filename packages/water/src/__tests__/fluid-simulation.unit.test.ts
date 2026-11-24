import { describe, expect, it } from 'vitest';
import {
  validWaterFluidConfiguration,
  type WaterFluidInstanceInput,
  type WaterFluidRecipe,
  WaterFluidSimulationSystem,
} from '../fluid-simulation.js';

function recipe(): WaterFluidRecipe {
  const target = (channels: WaterFluidRecipe['targets']['height']['channels']) => ({
    format: 'rgba16float' as const,
    filter: 'linear' as const,
    address: 'repeat' as const,
    origin: 'top-left' as const,
    channels,
    clear: [0, 0, 0, 1] as const,
  });
  return {
    kind: 'water-simulation-recipe',
    system: 'fluid-simulation',
    configurationVersion: 1,
    solverMode: 'ripple',
    terrainMode: 'constant-depth',
    resolution: [16, 16],
    virtualFps: 10,
    maxStepsPerFrame: 5,
    gridExtentM: [24, 24],
    maxImpulses: 8,
    waveFoam: { resolution: 16, gridExtentM: 24 },
    impulseNoiseGuid: '00000000-0000-7000-8000-000000000001',
    targets: {
      height: target('ripple-height-m'),
      velocity: target('velocity-xz-m/s'),
      normalHeight: target('normal-xz-height-m'),
      forces: target('height-foam-mask'),
      velocityForces: target('velocity-xz-m/s'),
      wave: target('wave-foam'),
      foam: target('foam'),
    },
    injectionLimits: {
      heightDeltaM: { encodedRange: [-2, 2], unit: 'm' },
      foamStrength: { encodedRange: [0, 4], unit: 'unitless' },
    },
    parameters: {
      travelSpeed: 0.95,
      rippleDamping: 0.01,
      rippleFoamDamping: 0.998,
      rippleFoamErasure: 0.1,
      fluidDampingPerSecond: 0.1,
      gravityMPerSecSquared: 9.8,
      shallowEdgeLengthM: 0.001,
      shallowFadingBackPerSecond: 0.25,
      terrainUseWaterDepthOnly: 0,
      shallowFoamFadePerSecond: 2,
      shallowFoamInjection: 0.5,
      shallowVelocityForFoamMPerSecond: 1.28,
      shallowFoamSlopeMinimum: 0.5,
      shallowFoamSlopeRange: 0.05,
      shallowNormalHeightScale: 5,
      constantWaterDepthM: 2,
      evaporationMPerSecond: 0,
      maskThreshold: 0.5,
      normalHeightScale: 1,
      waveNormalAmount: 10,
      waveNormalBias: 0,
      waveMinimumHeightM: 0.48,
      normalDefaultDepthM: 0,
      normalFoamAmount: 0.01,
      normalFoamHeightScale: 16,
      normalEdgeFalloff: 0.2,
      waveHeightDivisorM: 0.48,
      waveEdgeFalloff: 0.2,
      waveTimeBiasSeconds: 0,
      foamFadePerFrame: 0.006,
      foamDiffusion: 0.5,
      foamEdgeFalloff: 0.2,
      foamWetPerMeter: 2,
      foamWetFadePerFrame: 0.001,
      foamToneMapDensity: 0.1,
    },
    shallowFoamEnabled: true,
    foamEnabled: true,
    materialGuids: [],
    textureGuids: [],
  };
}
function input(): WaterFluidInstanceInput {
  return {
    instanceId: 'local-fluid',
    recipeGuid: 'recipe',
    recipeVersion: '1',
    recipe: recipe(),
    bodyGuid: 'body',
    bodyGeneration: 1,
    centerM: [0, 0, 0],
    waveFoamCenterM: [0, 0, 0],
    enabled: true,
    resetRevision: 0,
    impulseNoiseDependency: {
      guid: '00000000-0000-7000-8000-000000000001',
      kind: 'texture',
      status: 'valid',
    },
  };
}
const force = {
  kind: 'direct' as const,
  positionM: [0, 0, 0] as const,
  radiusM: 1,
  heightDeltaM: 0.2,
  lifetimeSeconds: 0,
  foamStrength: 0.5,
};
function mounted() {
  const system = new WaterFluidSimulationSystem();
  const instance = input();
  system.reconcile([instance]).unwrap();
  return { system, instance };
}
function frame(
  system: WaterFluidSimulationSystem,
  time: number,
  generation = 0,
  session?: string,
  sourceFrame = Math.round(time * 1_000_000),
) {
  const value = system.prepare(time, generation, sourceFrame, session).unwrap()[0];
  if (value === undefined) throw new Error('Missing enabled fluid');
  return value;
}

describe('Water fluid source admission and submission', () => {
  it('admits both explicit kernel versions and rejects unknown versions', () => {
    for (const configurationVersion of [1, 2])
      expect(validWaterFluidConfiguration({ ...recipe(), configurationVersion })).toBe(true);
    expect(validWaterFluidConfiguration({ ...recipe(), configurationVersion: 3 })).toBe(false);
  });
  it('rejects rectangular grids that cannot preserve the scalar source sampling contract', () => {
    const configuration = recipe();
    expect(validWaterFluidConfiguration({ ...configuration, resolution: [16, 8] })).toBe(false);
    expect(validWaterFluidConfiguration({ ...configuration, gridExtentM: [24, 18] })).toBe(false);
  });
  it('rejects an incompatible target channel contract before mounting any instance', () => {
    const { system, instance } = mounted();
    const bad = structuredClone(instance);
    Object.assign(bad.recipe.targets.height, { channels: 'shallow-depth-bed-m' });
    expect(validWaterFluidConfiguration(bad.recipe)).toBe(false);
    expect(system.reconcile([bad])).toMatchObject({
      ok: false,
      error: { code: 'fluid-recipe-invalid' },
    });
    expect(frame(system, 0).instance.recipe.targets.height.channels).toBe('ripple-height-m');
  });

  it('advances only accepted fixed steps and rereads one force snapshot during catch-up', () => {
    const { system } = mounted();
    system.submit(frame(system, 0)).unwrap();
    system.enqueueImpulse('local-fluid', force).unwrap();
    expect(frame(system, 0.1).steps).toHaveLength(0);
    const candidate = frame(system, 0.31);
    expect(candidate.steps).toHaveLength(3);
    expect(candidate.steps.map((step) => step.impulses[0]?.sequence)).toEqual([1, 1, 1]);
    expect(candidate.steps.map((step) => step.after.current)).toEqual([2, 1, 0]);
    expect(frame(system, 0.31)).toEqual(candidate);
    expect(system.inspect()['local-fluid']?.queuedImpulses).toBe(1);
    system.submit(candidate).unwrap();
    expect(system.inspect()['local-fluid']).toMatchObject({
      kind: 'active',
      fixedStep: 3,
      queuedImpulses: 0,
    });
    expect(frame(system, 0.41).impulses).toEqual([]);
  });

  it('advances foam once per accepted outer frame, including zero-substep frames', () => {
    const { system } = mounted();
    const initial = frame(system, 0);
    expect(initial.steps).toHaveLength(0);
    expect(initial.roles.foamReadSide).toBe(1);
    system.submit(initial).unwrap();
    const catchup = frame(system, 0.41);
    expect(catchup.steps).toHaveLength(4);
    expect(
      catchup.steps.every(
        (step) => step.before.foamReadSide === 1 && step.after.foamReadSide === 1,
      ),
    ).toBe(true);
    expect(catchup.roles.foamReadSide).toBe(0);
    system.submit(catchup).unwrap();
    expect(frame(system, 0.42).roles.foamReadSide).toBe(1);
  });

  it('consumes a submitted outer-frame force snapshot even without a solver substep', () => {
    const { system } = mounted();
    system.submit(frame(system, 0)).unwrap();
    system.enqueueImpulse('local-fluid', force).unwrap();
    const zero = frame(system, 0.05);
    expect(zero.steps).toHaveLength(0);
    expect(zero.impulses).toHaveLength(1);
    system.submit(zero).unwrap();
    expect(system.inspect()['local-fluid']?.queuedImpulses).toBe(0);
    expect(frame(system, 0.31).steps.every((step) => step.impulses.length === 0)).toBe(true);
  });

  it('rejects an older zero-step acknowledgment at the same time without losing newer active inputs', () => {
    const { system } = mounted();
    system.submit(frame(system, 0)).unwrap();
    system.enqueueImpulse('local-fluid', { ...force, lifetimeSeconds: 10 }).unwrap();
    const older = frame(system, 0.05, 0, undefined, 1);
    system
      .enqueueImpulse('local-fluid', { ...force, heightDeltaM: -0.4, lifetimeSeconds: 10 })
      .unwrap();
    const newer = frame(system, 0.05, 0, undefined, 2);
    expect(older.steps).toEqual([]);
    expect(newer.steps).toEqual([]);
    system.submit(newer).unwrap();
    expect.soft(system.submit(older)).toMatchObject({
      ok: false,
      error: { code: 'fluid-step-stale' },
    });
    expect.soft(system.inspect()['local-fluid']).toMatchObject({
      queuedImpulses: 0,
      activeImpulses: [{ sequence: 1 }, { sequence: 2 }],
    });
    expect
      .soft(frame(system, 0.05).activeImpulses.map((impulse) => impulse.sequence))
      .toEqual([1, 2]);
    expect(system.submit(newer)).toMatchObject({ ok: false, error: { code: 'fluid-step-stale' } });
  });

  it('rejects an older zero-step acknowledgment without a new force when capture centers change', () => {
    const { system, instance } = mounted();
    system.submit(frame(system, 0)).unwrap();
    system.reconcile([{ ...instance, waveFoamCenterM: [1, 0, 0] }]).unwrap();
    const older = frame(system, 0.05, 0, undefined, 1);
    system.reconcile([{ ...instance, waveFoamCenterM: [2, 0, 0] }]).unwrap();
    const newer = frame(system, 0.05, 0, undefined, 2);
    expect(older.consumedImpulseSequence).toBe(newer.consumedImpulseSequence);
    expect(older.steps).toEqual([]);
    expect(newer.steps).toEqual([]);
    system.submit(newer).unwrap();
    expect.soft(system.submit(older)).toMatchObject({
      ok: false,
      error: { code: 'fluid-step-stale' },
    });
    expect.soft(system.inspect()['local-fluid']).toMatchObject({ waveFoamCenterM: [2, 0, 0] });
  });

  it('redraws an accepted impulse until its strict outer-frame lifetime expires', () => {
    const { system } = mounted();
    system.submit(frame(system, 0)).unwrap();
    system.enqueueImpulse('local-fluid', { ...force, lifetimeSeconds: 1 }).unwrap();
    const accepted = frame(system, 0.61);
    system.submit(accepted).unwrap();
    const surviving = frame(system, 0.8);
    expect(surviving.impulses).toHaveLength(1);
    system.submit(surviving).unwrap();
    const expiring = frame(system, 1);
    expect(expiring.impulses).toHaveLength(1);
    system.submit(expiring).unwrap();
    expect(frame(system, 1.01).impulses).toEqual([]);
  });

  it.each([
    'disable',
    'mode',
    'recipe-version',
    'recipe-configuration',
  ] as const)('retains accepted queued inputs and sequence across %s until successful submission', (change) => {
    const { system, instance } = mounted();
    expect(system.enqueueImpulse('local-fluid', force).unwrap()).toBe(1);
    const old = frame(system, 0);
    expect(system.enqueueImpulse('local-fluid', { ...force, heightDeltaM: -0.4 }).unwrap()).toBe(2);
    const next =
      change === 'disable'
        ? { ...instance, enabled: false }
        : change === 'mode'
          ? {
              ...instance,
              recipe: {
                ...instance.recipe,
                solverMode: 'shallow' as const,
                targets: {
                  ...instance.recipe.targets,
                  height: {
                    ...instance.recipe.targets.height,
                    channels: 'shallow-depth-bed-m' as const,
                  },
                },
              },
            }
          : change === 'recipe-version'
            ? { ...instance, recipeVersion: '2' }
            : {
                ...instance,
                recipe: {
                  ...instance.recipe,
                  parameters: { ...instance.recipe.parameters, travelSpeed: 0.8 },
                },
              };
    system.reconcile([next]).unwrap();
    expect(system.inspect()['local-fluid']?.queuedImpulses).toBe(2);
    expect(system.submit(old)).toMatchObject({ ok: false, error: { code: 'fluid-step-stale' } });
    if (change === 'disable') {
      expect(system.prepare(5, 0, 1).unwrap()).toEqual([]);
      expect(system.enqueueImpulse('local-fluid', force)).toMatchObject({
        ok: false,
        error: { code: 'fluid-force-invalid', detail: { reason: 'disabled' } },
      });
      system.reconcile([{ ...next, enabled: true }]).unwrap();
    }
    const resumed = frame(system, 5);
    expect(resumed.initialize).toBe(true);
    expect(resumed.pendingImpulses).toEqual([
      { ...force, sequence: 1 },
      { ...force, heightDeltaM: -0.4, sequence: 2 },
    ]);
    expect(frame(system, 5)).toEqual(resumed);
    expect(system.inspect()['local-fluid']?.queuedImpulses).toBe(2);
    expect(system.enqueueImpulse('local-fluid', force).unwrap()).toBe(3);
    system.submit(resumed).unwrap();
    expect(system.inspect()['local-fluid']?.queuedImpulses).toBe(1);
    expect(frame(system, 5).pendingImpulses.map((impulse) => impulse.sequence)).toEqual([3]);
  });

  it.each([
    'reset',
    'body-guid',
    'body-generation',
    'removal',
  ] as const)('clears queued inputs on %s', (change) => {
    const { system, instance } = mounted();
    system.enqueueImpulse('local-fluid', force).unwrap();
    const next =
      change === 'reset'
        ? { ...instance, resetRevision: 1 }
        : change === 'body-guid'
          ? { ...instance, bodyGuid: 'replacement' }
          : change === 'body-generation'
            ? { ...instance, bodyGeneration: 2 }
            : instance;
    if (change === 'removal') system.reconcile([]).unwrap();
    system.reconcile([next]).unwrap();
    expect(system.inspect()['local-fluid']?.queuedImpulses).toBe(0);
    expect(frame(system, 5).pendingImpulses).toEqual([]);
  });

  it('publishes deeply immutable snapshots detached from caller configuration and forces', () => {
    const { system, instance } = mounted();
    system.enqueueImpulse('local-fluid', force).unwrap();
    const candidate = frame(system, 0);
    const [impulse] = candidate.impulses;
    if (impulse === undefined) throw new Error('Expected the enqueued fluid impulse');
    expect(() => {
      (candidate.instance.centerM as number[])[0] = 4;
    }).toThrow(TypeError);
    expect(() => {
      (impulse.positionM as number[])[0] = 4;
    }).toThrow(TypeError);
    expect(() => {
      candidate.instance.recipe.parameters.waveNormalAmount = 4;
    }).toThrow(TypeError);
    Object.assign(instance.recipe.parameters, { waveNormalAmount: 4 });
    expect(frame(system, 0).instance.recipe.parameters.waveNormalAmount).toBe(10);
  });

  it('restarts device history and rejects late feedback from the previous device', () => {
    const { system } = mounted();
    system.submit(frame(system, 0)).unwrap();
    const previous = frame(system, 0.31);
    system.submit(previous).unwrap();
    const recovered = frame(system, 0.4, 1, undefined, 0);
    expect(recovered).toMatchObject({ initialize: true, baseStep: 0, steps: [] });
    system.submit(recovered).unwrap();
    expect(system.submit(previous)).toMatchObject({
      ok: false,
      error: { code: 'fluid-step-stale' },
    });
    expect(system.inspect()['local-fluid']).toMatchObject({
      kind: 'active',
      deviceGeneration: 1,
      fixedStep: 0,
    });
  });

  it('restarts a new receiving session and rejects acknowledgments from its predecessor', () => {
    const { system } = mounted();
    const previous = frame(system, 0, 0, 'receiver-a');
    system.submit(previous).unwrap();
    const next = frame(system, 0.3, 0, 'receiver-b');
    expect(next.initialize).toBe(true);
    expect(next.simulationGeneration).toBeGreaterThan(previous.simulationGeneration);
    expect(system.submit(previous)).toMatchObject({
      ok: false,
      error: { code: 'fluid-step-stale' },
    });
    system.submit(next).unwrap();
  });

  it('retains two submitted grid centers and leaves CPU body data outside the visual field', () => {
    const { system, instance } = mounted();
    system.submit(frame(system, 0)).unwrap();
    system.reconcile([{ ...instance, centerM: [3, 0, 2] }]).unwrap();
    const moved = frame(system, 0.11);
    expect(moved.steps[0]).toMatchObject({
      centerM: [3, 0, 2],
      previousCenterM: [0, 0, 0],
      previous2CenterM: [0, 0, 0],
    });
    system.submit(moved).unwrap();
    expect(system.inspect()['local-fluid']).toMatchObject({ centerM: [3, 0, 2] });
    expect(instance.centerM).toEqual([0, 0, 0]);
  });

  it('admits the full-radius XZ circle against the cached solver center, independently of Y', () => {
    const { system, instance } = mounted();
    system.submit(frame(system, 0)).unwrap();
    expect(system.enqueueImpulse('local-fluid', { ...force, positionM: [24, 1e6, 0] }).ok).toBe(
      true,
    );
    expect(system.enqueueImpulse('local-fluid', { ...force, positionM: [24.00001, 0, 0] }).ok).toBe(
      false,
    );
    system.reconcile([{ ...instance, centerM: [50, 0, 0] }]).unwrap();
    expect(system.enqueueImpulse('local-fluid', { ...force, positionM: [0, 0, 0] }).ok).toBe(true);
    expect(system.enqueueImpulse('local-fluid', { ...force, positionM: [50, 0, 0] }).ok).toBe(
      false,
    );
    system.submit(frame(system, 0.11)).unwrap();
    expect(system.enqueueImpulse('local-fluid', { ...force, positionM: [50, -1e6, 24] }).ok).toBe(
      true,
    );
    expect(system.enqueueImpulse('local-fluid', { ...force, positionM: [0, 0, 0] }).ok).toBe(false);
  });

  it('reinitializes RT history while active impulse timers freeze across disable and mode changes', () => {
    const { system, instance } = mounted();
    const initial = frame(system, 0);
    system.submit(initial).unwrap();
    system.enqueueImpulse('local-fluid', { ...force, lifetimeSeconds: 10 }).unwrap();
    const active = frame(system, 0.31);
    system.submit(active).unwrap();
    system.enqueueImpulse('local-fluid', force).unwrap();
    const late = frame(system, 0.42);
    system.reconcile([{ ...instance, enabled: false }]).unwrap();
    expect(system.prepare(0.5, 0, 500_000).unwrap()).toEqual([]);
    expect(system.inspect()['local-fluid']).toMatchObject({
      kind: 'disabled',
      queuedImpulses: 1,
      activeImpulses: [{ elapsedSeconds: 0.31 }],
    });
    expect(system.submit(late)).toMatchObject({ ok: false, error: { code: 'fluid-step-stale' } });
    const moved = { ...instance, centerM: [3, 0, 2] as const };
    system.reconcile([moved]).unwrap();
    const restarted = frame(system, 5);
    expect(restarted.simulationGeneration).toBeGreaterThan(active.simulationGeneration);
    expect(restarted).toMatchObject({
      initialize: true,
      baseStep: 0,
      steps: [],
      activeImpulses: [{ elapsedSeconds: 0.31 }],
      virtualTimeSeconds: 0,
      accumulatorSeconds: 0,
      roles: initial.roles,
      previousCenterM: moved.centerM,
      previous2CenterM: moved.centerM,
    });
    expect(system.submit(late)).toMatchObject({ ok: false, error: { code: 'fluid-step-stale' } });
    system.submit(restarted).unwrap();
    expect(system.inspect()['local-fluid']).toMatchObject({
      kind: 'active',
      fixedStep: 0,
      centerM: moved.centerM,
    });
    const shallow = {
      ...moved,
      recipe: {
        ...moved.recipe,
        solverMode: 'shallow' as const,
        targets: {
          ...moved.recipe.targets,
          height: { ...moved.recipe.targets.height, channels: 'shallow-depth-bed-m' as const },
        },
      },
    };
    system.reconcile([shallow]).unwrap();
    const switched = frame(system, 10);
    expect(switched).toMatchObject({
      initialize: true,
      impulses: [{ heightDeltaM: 0.2 }],
      activeImpulses: [{ elapsedSeconds: 0.31 }],
    });
    system.submit(switched).unwrap();
    system.reconcile([{ ...shallow, resetRevision: 1 }]).unwrap();
    expect(frame(system, 20).activeImpulses).toEqual([]);
  });
});
