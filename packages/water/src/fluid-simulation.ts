import {
  canonicalJson,
  err,
  ok,
  type Result,
  type WaterFluidSimulationSource,
  type WaterFluidTarget,
  type WaterFluidTargetChannels,
  type WaterVec2,
} from '@forgeax/engine-types';
import type { WaterDependencySnapshot } from './contracts.js';

export type WaterFluidRecipe = WaterFluidSimulationSource & {
  readonly kind: 'water-simulation-recipe';
};
export interface WaterFluidSubmissionIdentity {
  readonly sourceFrame: number;
  readonly simulationGeneration: number;
  readonly deviceGeneration: number;
  readonly fixedStep: number;
  readonly timeSeconds: number;
}
type WaterFluidFailure =
  | Readonly<{
      code: 'fluid-recipe-invalid';
      detail: Readonly<{ instanceId: string; field: 'recipe' }>;
    }>
  | Readonly<{
      code: 'fluid-instance-invalid';
      detail: Readonly<{
        instanceId?: string;
        field: 'instance' | 'frame' | 'scene-closure';
        reason:
          | 'identity-grid-or-body'
          | 'time-device-or-source-frame'
          | 'unresolved-scene-closure';
      }>;
    }>
  | Readonly<{
      code: 'fluid-force-invalid';
      detail: Readonly<{
        instanceId: string;
        field: 'impulse';
        reason: 'disabled' | 'shape-or-limits' | 'outside-admission-circle';
      }>;
    }>
  | Readonly<{
      code: 'fluid-force-capacity';
      detail: Readonly<{
        instanceId: string;
        field: 'impulses';
        queued: number;
        active: number;
        capacity: number;
      }>;
    }>
  | Readonly<{
      code: 'fluid-instance-missing';
      detail: Readonly<{ instanceId: string; field: 'instance' }>;
    }>
  | Readonly<{
      code: 'fluid-step-stale';
      detail: Readonly<{
        instanceId: string;
        field: 'submission';
        submitted: WaterFluidSubmissionIdentity;
        current?: WaterFluidSubmissionIdentity;
      }>;
    }>;
export type WaterFluidError = WaterFluidFailure &
  Readonly<{
    readonly expected: string;
    readonly hint: string;
  }>;
export type WaterFluidErrorCode = WaterFluidError['code'];
const failure = (problem: WaterFluidFailure, expected: string): WaterFluidError => ({
  ...problem,
  expected,
  hint: 'repair the named fluid source and retry the same instance',
});
const targets: readonly WaterFluidTarget[] = [
  'height',
  'velocity',
  'normalHeight',
  'forces',
  'velocityForces',
  'wave',
  'foam',
];
const channels: Readonly<Record<Exclude<WaterFluidTarget, 'height'>, WaterFluidTargetChannels>> = {
  velocity: 'velocity-xz-m/s',
  velocityForces: 'velocity-xz-m/s',
  normalHeight: 'normal-xz-height-m',
  forces: 'height-foam-mask',
  wave: 'wave-foam',
  foam: 'foam',
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
function vector(value: unknown, length: 2): value is [number, number];
function vector(value: unknown, length: 3): value is [number, number, number];
function vector(value: unknown, length: 4): value is [number, number, number, number];
function vector(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}
function immutableSnapshot<T>(value: T): T {
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  const snapshot = structuredClone(value);
  freeze(snapshot);
  return snapshot;
}

/** Source admission is shared by Pack decoding and live Scene configuration. */
export function validWaterFluidConfiguration(value: unknown): value is WaterFluidRecipe {
  if (
    !object(value) ||
    invalidFluidRecipeIdentity(value) ||
    invalidFluidRecipeGrid(value) ||
    invalidFluidWaveFoamDomain(value) ||
    invalidFluidRecipeSubmission(value)
  )
    return false;
  for (const name of targets) {
    if (!validFluidTarget((value.targets as Record<string, unknown>)[name], value.solverMode, name))
      return false;
  }
  if (!validFluidInjectionLimits(value)) return false;
  const keys = [
    'travelSpeed',
    'rippleDamping',
    'rippleFoamDamping',
    'rippleFoamErasure',
    'fluidDampingPerSecond',
    'gravityMPerSecSquared',
    'shallowEdgeLengthM',
    'shallowFadingBackPerSecond',
    'terrainUseWaterDepthOnly',
    'shallowFoamFadePerSecond',
    'shallowFoamInjection',
    'shallowVelocityForFoamMPerSecond',
    'shallowFoamSlopeMinimum',
    'shallowFoamSlopeRange',
    'shallowNormalHeightScale',
    'constantWaterDepthM',
    'evaporationMPerSecond',
    'maskThreshold',
    'normalHeightScale',
    'normalDefaultDepthM',
    'normalFoamAmount',
    'normalFoamHeightScale',
    'normalEdgeFalloff',
    'waveNormalAmount',
    'waveNormalBias',
    'waveMinimumHeightM',
    'waveHeightDivisorM',
    'waveEdgeFalloff',
    'waveTimeBiasSeconds',
    'foamFadePerFrame',
    'foamDiffusion',
    'foamEdgeFalloff',
    'foamWetPerMeter',
    'foamWetFadePerFrame',
    'foamToneMapDensity',
  ];
  if (
    !closed(value.parameters, keys) ||
    !Object.values(value.parameters).every((n) => typeof n === 'number' && Number.isFinite(n))
  )
    return false;
  const p = value.parameters as WaterFluidRecipe['parameters'];
  return (
    validFluidRippleParameters(p) &&
    validFluidShallowParameters(p) &&
    validFluidWaveParameters(p) &&
    validFluidNormalParameters(p) &&
    validFluidFoamParameters(p)
  );
}

export interface WaterFluidInstanceInput {
  readonly instanceId: string;
  readonly recipeGuid: string;
  readonly recipeVersion: string;
  readonly recipe: WaterFluidRecipe;
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
  readonly centerM: readonly [number, number, number];
  readonly waveFoamCenterM: readonly [number, number, number];
  readonly enabled: boolean;
  readonly resetRevision: number;
  readonly impulseNoiseDependency: WaterDependencySnapshot;
}
const instanceSignature = (input: WaterFluidInstanceInput) =>
  canonicalJson({
    ...input,
    centerM: undefined,
    waveFoamCenterM: undefined,
    impulseNoiseDependency: undefined,
  });
/** Default material impulse. Height is metres; generated G remains source numeric foam. */
export type WaterFluidImpulse = {
  readonly positionM: readonly [number, number, number];
  readonly radiusM: number;
  readonly heightDeltaM: number;
  readonly foamStrength: number;
  readonly lifetimeSeconds: number;
} & (
  | { readonly kind: 'direct' }
  | {
      readonly kind: 'splash';
      readonly startOffsetSeconds: number;
      readonly strengthOverLifePower: number;
    }
);
export type WaterFluidQueuedImpulse = WaterFluidImpulse & { readonly sequence: number };
export type WaterFluidActiveImpulse = WaterFluidQueuedImpulse & { readonly elapsedSeconds: number };
export interface WaterFluidDrawImpulse {
  readonly positionM: readonly [number, number, number];
  readonly radiusM: number;
  readonly heightDeltaM: number;
  readonly foamStrength: number;
  readonly sequence: number;
}
export interface WaterFluidRoles {
  readonly current: 0 | 1 | 2;
  readonly previous: 0 | 1 | 2;
  readonly freeTarget: 0 | 1 | 2;
  readonly heightReadSide: 0 | 1;
  readonly velocityReadSide: 0 | 1;
  readonly foamReadSide: 0 | 1;
}
const INITIAL_ROLES: WaterFluidRoles = Object.freeze({
  current: 0,
  previous: 1,
  freeTarget: 2,
  heightReadSide: 0,
  velocityReadSide: 0,
  foamReadSide: 0,
});
export interface WaterFluidStep {
  readonly fixedStep: number;
  readonly virtualTimeSeconds: number;
  readonly dt: number;
  readonly centerM: readonly [number, number, number];
  readonly previousCenterM: readonly [number, number, number];
  readonly previous2CenterM: readonly [number, number, number];
  readonly before: WaterFluidRoles;
  readonly after: WaterFluidRoles;
  readonly impulses: readonly WaterFluidDrawImpulse[];
}
export interface WaterFluidFrame {
  readonly instance: WaterFluidInstanceInput;
  readonly sourceFrame: number;
  readonly simulationGeneration: number;
  readonly deviceGeneration: number;
  readonly baseStep: number;
  readonly initialize: boolean;
  readonly steps: readonly WaterFluidStep[];
  readonly roles: WaterFluidRoles;
  readonly timeSeconds: number;
  readonly virtualTimeSeconds: number;
  readonly accumulatorSeconds: number;
  readonly consumedImpulseSequence: number;
  readonly pendingImpulses: readonly WaterFluidQueuedImpulse[];
  readonly initialActiveImpulses: readonly WaterFluidActiveImpulse[];
  readonly activeImpulses: readonly WaterFluidActiveImpulse[];
  readonly impulses: readonly WaterFluidDrawImpulse[];
  readonly outerDeltaSeconds: number;
  readonly waveFoamCenterM: readonly [number, number, number];
  readonly previousWaveFoamCenterM: readonly [number, number, number];
  readonly previous2WaveFoamCenterM: readonly [number, number, number];
  readonly previousFrameCenterM: readonly [number, number, number];
  readonly previousCenterM: readonly [number, number, number];
  readonly previous2CenterM: readonly [number, number, number];
}

/** The same transition runs at extraction and at the receiving render submission. */
export function prepareWaterFluidFrame(
  input: WaterFluidInstanceInput,
  simulationGeneration: number,
  timeSeconds: number,
  deviceGeneration: number,
  sourceFrame: number,
  pendingImpulses: readonly WaterFluidQueuedImpulse[],
  submitted?: WaterFluidFrame,
  initialActiveImpulses: readonly WaterFluidActiveImpulse[] = [],
): WaterFluidFrame {
  const initialize =
    submitted === undefined ||
    submitted.deviceGeneration !== deviceGeneration ||
    submitted.simulationGeneration !== simulationGeneration;
  const base = initialize ? undefined : submitted;
  const prior = submitted?.simulationGeneration === simulationGeneration ? submitted : undefined;
  const dt = 1 / input.recipe.virtualFps;
  const outerDeltaSeconds = base === undefined ? 0 : Math.max(0, timeSeconds - base.timeSeconds);
  const elapsed = Math.min(outerDeltaSeconds, dt * input.recipe.maxStepsPerFrame);
  let accumulator = (base?.accumulatorSeconds ?? 0) + elapsed;
  let roles = base?.roles ?? INITIAL_ROLES;
  let previousCenterM = base?.previousCenterM ?? input.centerM;
  let previous2CenterM = base?.previous2CenterM ?? input.centerM;
  let virtualTime = base?.virtualTimeSeconds ?? 0;
  const previousFrameCenterM = previousCenterM;
  const waveFoamCenterM = input.waveFoamCenterM;
  const previousWaveFoamCenterM = base?.waveFoamCenterM ?? waveFoamCenterM;
  const previous2WaveFoamCenterM = base?.previousWaveFoamCenterM ?? waveFoamCenterM;
  const baseStep = fluidLastSubmittedStep(base);
  const pending = pendingImpulses.filter(
    (impulse) => impulse.sequence > (prior?.consumedImpulseSequence ?? 0),
  );
  const active = [
    ...(prior?.activeImpulses ?? initialActiveImpulses),
    ...pending.map((impulse) => ({ ...impulse, elapsedSeconds: 0 })),
  ];
  const impulses: WaterFluidDrawImpulse[] = [];
  appendActiveFluidDrawImpulses(active, impulses);
  const steps: WaterFluidStep[] = [];
  // Draw one force snapshot per outer frame; catch-up steps reread it.
  for (let index = 0; index < input.recipe.maxStepsPerFrame && accumulator > dt; index++) {
    const next: WaterFluidRoles = Object.freeze({
      ...roles,
      ...(input.recipe.solverMode === 'ripple'
        ? { previous: roles.current, current: roles.freeTarget, freeTarget: roles.previous }
        : {}),
    });
    virtualTime += dt;
    steps.push(
      Object.freeze({
        fixedStep: baseStep + index + 1,
        virtualTimeSeconds: virtualTime,
        dt,
        centerM: input.centerM,
        previousCenterM,
        previous2CenterM,
        before: roles,
        after: next,
        impulses,
      }),
    );
    previous2CenterM = previousCenterM;
    previousCenterM = input.centerM;
    roles = next;
    accumulator -= dt;
  }
  if (input.recipe.foamEnabled)
    roles = Object.freeze({ ...roles, foamReadSide: (1 - roles.foamReadSide) as 0 | 1 });
  const activeImpulses = active
    .map((impulse) => ({ ...impulse, elapsedSeconds: impulse.elapsedSeconds + outerDeltaSeconds }))
    .filter(
      (impulse) =>
        impulse.lifetimeSeconds >
        impulse.elapsedSeconds - (impulse.kind === 'splash' ? impulse.startOffsetSeconds : 0),
    );
  return immutableSnapshot({
    instance: input,
    sourceFrame,
    simulationGeneration,
    deviceGeneration,
    baseStep,
    initialize,
    steps: Object.freeze(steps),
    roles,
    timeSeconds,
    virtualTimeSeconds: virtualTime,
    accumulatorSeconds: Math.max(0, accumulator),
    pendingImpulses: pending,
    initialActiveImpulses,
    activeImpulses,
    impulses,
    outerDeltaSeconds,
    previousFrameCenterM,
    waveFoamCenterM,
    previousWaveFoamCenterM,
    previous2WaveFoamCenterM,
    consumedImpulseSequence: fluidConsumedImpulseSequence(pending, prior),
    previousCenterM,
    previous2CenterM,
  });
}
export type WaterFluidRuntimeState =
  | Readonly<{
      kind: 'disabled';
      simulationGeneration: number;
      queuedImpulses: number;
      activeImpulses: readonly WaterFluidActiveImpulse[];
    }>
  | Readonly<{
      kind: 'initializing';
      simulationGeneration: number;
      recipeGuid: string;
      queuedImpulses: number;
      activeImpulses: readonly WaterFluidActiveImpulse[];
    }>
  | Readonly<{
      kind: 'active';
      simulationGeneration: number;
      recipeGuid: string;
      mode: 'ripple' | 'shallow';
      deviceGeneration: number;
      fixedStep: number;
      virtualTimeSeconds: number;
      roles: WaterFluidRoles;
      centerM: readonly [number, number, number];
      waveFoamCenterM: readonly [number, number, number];
      previousWaveFoamCenterM: readonly [number, number, number];
      previous2WaveFoamCenterM: readonly [number, number, number];
      queuedImpulses: number;
      activeImpulses: readonly WaterFluidActiveImpulse[];
    }>
  | Readonly<{
      kind: 'unavailable';
      simulationGeneration: number;
      queuedImpulses: number;
      activeImpulses: readonly WaterFluidActiveImpulse[];
      error: WaterFluidError;
    }>;
interface Instance {
  input: WaterFluidInstanceInput;
  signature: string;
  generation: number;
  submitted?: WaterFluidFrame;
  pendingImpulses: WaterFluidQueuedImpulse[];
  activeImpulses: readonly WaterFluidActiveImpulse[];
  nextSequence: number;
  error?: WaterFluidError;
}

/** Scene-local visual simulation authority. GPU resources remain entirely graph-owned. */
export class WaterFluidSimulationSystem {
  private readonly instances = new Map<string, Instance>();
  private nextGeneration = 1;
  private receiverSession: string | undefined;

  reconcile(inputs: readonly WaterFluidInstanceInput[]): Result<void, WaterFluidError> {
    const seen = new Set<string>();
    const bodies = new Set<string>();
    for (const input of inputs) {
      if (!validFluidInstanceIdentity(input, seen, bodies))
        return err(
          failure(
            {
              code: 'fluid-instance-invalid',
              detail: {
                instanceId: input.instanceId,
                field: 'instance',
                reason: 'identity-grid-or-body',
              },
            },
            'a unique instance and Body with a finite world grid and valid generations',
          ),
        );
      if (!validWaterFluidConfiguration(input.recipe))
        return err(
          failure(
            {
              code: 'fluid-recipe-invalid',
              detail: { instanceId: input.instanceId, field: 'recipe' },
            },
            'a complete version-1 built-in Water fluid recipe with empty materialGuids and textureGuids',
          ),
        );
      seen.add(input.instanceId);
      if (input.enabled) bodies.add(input.bodyGuid);
    }
    for (const input of inputs) {
      const signature = instanceSignature(input);
      const previous = this.instances.get(input.instanceId);
      const detached = structuredClone(input);
      const retainInputs =
        previous !== undefined &&
        previous.input.bodyGuid === input.bodyGuid &&
        previous.input.bodyGeneration === input.bodyGeneration &&
        previous.input.resetRevision === input.resetRevision;
      if (previous?.signature === signature) previous.input = detached;
      else
        this.instances.set(input.instanceId, {
          input: detached,
          signature,
          generation: this.nextGeneration++,
          pendingImpulses: retainInputs ? previous.pendingImpulses : [],
          activeImpulses: retainInputs ? previous.activeImpulses : [],
          nextSequence: previous?.nextSequence ?? 1,
        });
    }
    for (const id of this.instances.keys()) if (!seen.has(id)) this.instances.delete(id);
    return ok(undefined);
  }

  enqueueImpulse(instanceId: string, impulse: WaterFluidImpulse): Result<number, WaterFluidError> {
    const instance = this.instances.get(instanceId);
    if (instance === undefined)
      return err(
        failure(
          { code: 'fluid-instance-missing', detail: { instanceId, field: 'instance' } },
          'a mounted Scene fluid instance',
        ),
      );
    if (!instance.input.enabled)
      return err(
        failure(
          {
            code: 'fluid-force-invalid',
            detail: { instanceId, field: 'impulse', reason: 'disabled' },
          },
          'an enabled fluid instance accepting impulses',
        ),
      );

    if (!validFluidImpulseShape(impulse, instance.input.recipe.injectionLimits))
      return err(
        failure(
          {
            code: 'fluid-force-invalid',
            detail: { instanceId, field: 'impulse', reason: 'shape-or-limits' },
          },
          'finite default impulse position/radius, admitted height and foam multiplier, and a valid lifetime',
        ),
      );
    if (
      instance.pendingImpulses.length + instance.activeImpulses.length >=
      instance.input.recipe.maxImpulses
    )
      return err(
        failure(
          {
            code: 'fluid-force-capacity',
            detail: {
              instanceId,
              field: 'impulses',
              queued: instance.pendingImpulses.length,
              active: instance.activeImpulses.length,
              capacity: instance.input.recipe.maxImpulses,
            },
          },
          'queued plus active impulses below the recipe capacity',
        ),
      );
    const center = instance.submitted?.previousCenterM ?? instance.input.centerM;
    const distanceSquared =
      (impulse.positionM[0] - center[0]) ** 2 + (impulse.positionM[2] - center[2]) ** 2;
    if (distanceSquared > instance.input.recipe.gridExtentM[0] ** 2)
      return err(
        failure(
          {
            code: 'fluid-force-invalid',
            detail: { instanceId, field: 'impulse', reason: 'outside-admission-circle' },
          },
          'an impulse position inside the cached XZ grid admission circle',
        ),
      );
    const sequence = instance.nextSequence++;
    instance.pendingImpulses.push(immutableSnapshot({ ...impulse, sequence }));
    return ok(sequence);
  }

  prepare(
    timeSeconds: number,
    deviceGeneration: number,
    sourceFrame: number,
    receiverSession?: string,
  ): Result<readonly WaterFluidFrame[], WaterFluidError> {
    if (
      !Number.isFinite(timeSeconds) ||
      !Number.isSafeInteger(deviceGeneration) ||
      deviceGeneration < 0 ||
      !Number.isSafeInteger(sourceFrame) ||
      sourceFrame < 0
    )
      return err(
        failure(
          {
            code: 'fluid-instance-invalid',
            detail: { field: 'frame', reason: 'time-device-or-source-frame' },
          },
          'finite virtual time and nonnegative integer device generation and source frame',
        ),
      );
    if (this.receiverSession !== receiverSession) {
      this.receiverSession = receiverSession;
      for (const instance of this.instances.values()) {
        instance.generation = this.nextGeneration++;
        delete instance.submitted;
        delete instance.error;
      }
    }
    const frames: WaterFluidFrame[] = [];
    for (const instance of this.instances.values()) {
      if (!instance.input.enabled) continue;
      frames.push(
        prepareWaterFluidFrame(
          instance.input,
          instance.generation,
          timeSeconds,
          deviceGeneration,
          sourceFrame,
          instance.pendingImpulses,
          instance.submitted,
          instance.activeImpulses,
        ),
      );
    }
    return ok(Object.freeze(frames));
  }

  /** Complete graph submissions advance once per source frame in each device generation. */
  submit(frame: WaterFluidFrame): Result<void, WaterFluidError> {
    const instance = this.instances.get(frame.instance.instanceId);
    const step = instance?.submitted?.steps.at(-1)?.fixedStep ?? instance?.submitted?.baseStep ?? 0;
    const sameDevice = instance?.submitted?.deviceGeneration === frame.deviceGeneration;
    if (instance === undefined || staleFluidSubmission(instance, frame, sameDevice, step))
      return err(
        failure(
          {
            code: 'fluid-step-stale',
            detail: {
              instanceId: frame.instance.instanceId,
              field: 'submission',
              submitted: {
                sourceFrame: frame.sourceFrame,
                simulationGeneration: frame.simulationGeneration,
                deviceGeneration: frame.deviceGeneration,
                fixedStep: frame.steps.at(-1)?.fixedStep ?? frame.baseStep,
                timeSeconds: frame.timeSeconds,
              },
              ...(instance === undefined
                ? {}
                : {
                    current: {
                      sourceFrame: instance.submitted?.sourceFrame ?? frame.sourceFrame,
                      simulationGeneration: instance.generation,
                      deviceGeneration:
                        instance.submitted?.deviceGeneration ?? frame.deviceGeneration,
                      fixedStep: step,
                      timeSeconds: instance.submitted?.timeSeconds ?? frame.timeSeconds,
                    },
                  }),
            },
          },
          'the current simulation/device generation and a newer source frame with monotonic fluid time',
        ),
      );
    instance.submitted = immutableSnapshot(frame);
    instance.pendingImpulses = instance.pendingImpulses.filter(
      (impulse) => impulse.sequence > frame.consumedImpulseSequence,
    );
    instance.activeImpulses = frame.activeImpulses;
    delete instance.error;
    return ok(undefined);
  }

  unavailable(instanceId: string, error: WaterFluidError): void {
    const instance = this.instances.get(instanceId);
    if (instance !== undefined) instance.error = structuredClone(error);
  }

  inspect(): Readonly<Record<string, WaterFluidRuntimeState>> {
    return Object.freeze(
      Object.fromEntries(
        [...this.instances].map(([id, state]) => {
          const common = {
            simulationGeneration: state.generation,
            queuedImpulses: state.pendingImpulses.length,
            activeImpulses: immutableSnapshot(state.activeImpulses),
          };
          const frame = state.submitted;
          const value: WaterFluidRuntimeState = !state.input.enabled
            ? { ...common, kind: 'disabled' }
            : state.error !== undefined
              ? { ...common, kind: 'unavailable', error: structuredClone(state.error) }
              : frame === undefined
                ? { ...common, kind: 'initializing', recipeGuid: state.input.recipeGuid }
                : {
                    ...common,
                    kind: 'active',
                    recipeGuid: state.input.recipeGuid,
                    mode: state.input.recipe.solverMode,
                    deviceGeneration: frame.deviceGeneration,
                    fixedStep: frame.steps.at(-1)?.fixedStep ?? frame.baseStep,
                    virtualTimeSeconds: frame.virtualTimeSeconds,
                    roles: frame.roles,
                    centerM: frame.previousCenterM,
                    waveFoamCenterM: frame.waveFoamCenterM,
                    previousWaveFoamCenterM: frame.previousWaveFoamCenterM,
                    previous2WaveFoamCenterM: frame.previous2WaveFoamCenterM,
                  };
          return [id, Object.freeze(value)];
        }),
      ),
    );
  }
  clear(): void {
    this.instances.clear();
  }
}

function invalidFluidRecipeIdentity(value: Record<string, unknown>): boolean {
  return (
    value.kind !== 'water-simulation-recipe' ||
    value.system !== 'fluid-simulation' ||
    (value.configurationVersion !== 1 && value.configurationVersion !== 2) ||
    !['ripple', 'shallow'].includes(String(value.solverMode)) ||
    !['none', 'constant-depth', 'water-info'].includes(String(value.terrainMode))
  );
}

function invalidFluidRecipeGrid(value: Record<string, unknown>): boolean {
  return (
    !vector(value.resolution, 2) ||
    !value.resolution.every((n) => Number.isSafeInteger(n) && n >= 4) ||
    !vector(value.gridExtentM, 2) ||
    !value.gridExtentM.every((n) => n > 0) ||
    value.resolution[0] !== value.resolution[1] ||
    value.gridExtentM[0] !== value.gridExtentM[1]
  );
}

function invalidFluidWaveFoamDomain(value: Record<string, unknown>): boolean {
  return (
    !closed(value.waveFoam, ['resolution', 'gridExtentM']) ||
    !Number.isSafeInteger(value.waveFoam.resolution) ||
    (value.waveFoam.resolution as number) < 4 ||
    typeof value.waveFoam.gridExtentM !== 'number' ||
    !Number.isFinite(value.waveFoam.gridExtentM) ||
    value.waveFoam.gridExtentM <= 0
  );
}

function invalidFluidRecipeSubmission(value: Record<string, unknown>): boolean {
  return (
    typeof value.virtualFps !== 'number' ||
    !Number.isFinite(value.virtualFps) ||
    value.virtualFps <= 0 ||
    !Number.isSafeInteger(value.maxStepsPerFrame) ||
    (value.maxStepsPerFrame as number) < 1 ||
    (value.maxStepsPerFrame as number) > 16 ||
    !Number.isSafeInteger(value.maxImpulses) ||
    (value.maxImpulses as number) < 1 ||
    typeof value.impulseNoiseGuid !== 'string' ||
    value.impulseNoiseGuid.length === 0 ||
    !Array.isArray(value.materialGuids) ||
    value.materialGuids.length !== 0 ||
    !Array.isArray(value.textureGuids) ||
    value.textureGuids.length !== 0 ||
    typeof value.foamEnabled !== 'boolean' ||
    typeof value.shallowFoamEnabled !== 'boolean' ||
    !closed(value.targets, targets)
  );
}

function validFluidTarget(target: unknown, solverMode: unknown, name: WaterFluidTarget): boolean {
  if (
    !closed(target, ['format', 'filter', 'address', 'origin', 'channels', 'clear']) ||
    !['rgba16float', 'rgba32float', 'rg32float', 'rg16float'].includes(String(target.format)) ||
    !['nearest', 'linear'].includes(String(target.filter)) ||
    !['clamp-to-edge', 'repeat'].includes(String(target.address)) ||
    target.origin !== 'top-left' ||
    target.channels !==
      (name === 'height'
        ? solverMode === 'ripple'
          ? 'ripple-height-m'
          : 'shallow-depth-bed-m'
        : channels[name]) ||
    !vector(target.clear, 4)
  )
    return false;
  if (
    !['velocity', 'velocityForces'].includes(name) &&
    !['rgba16float', 'rgba32float'].includes(String(target.format))
  )
    return false;
  if (name === 'forces' && !target.clear.every((n, index) => n === (index === 3 ? 1 : 0)))
    return false;

  return true;
}

function validFluidRippleParameters(p: WaterFluidRecipe['parameters']): boolean {
  return (
    p.travelSpeed >= 0 &&
    p.travelSpeed <= 1 &&
    p.rippleDamping >= 0 &&
    p.rippleDamping <= 1 &&
    p.rippleFoamDamping >= 0 &&
    p.rippleFoamDamping <= 1 &&
    p.rippleFoamErasure >= 0 &&
    p.fluidDampingPerSecond >= 0 &&
    p.gravityMPerSecSquared >= 0 &&
    p.shallowEdgeLengthM > 0 &&
    p.constantWaterDepthM > 0
  );
}

function validFluidShallowParameters(p: WaterFluidRecipe['parameters']): boolean {
  return (
    p.shallowFadingBackPerSecond >= 0 &&
    p.terrainUseWaterDepthOnly >= 0 &&
    p.terrainUseWaterDepthOnly <= 1 &&
    p.shallowFoamFadePerSecond >= 0 &&
    p.shallowFoamInjection >= 0 &&
    p.shallowVelocityForFoamMPerSecond > 0 &&
    p.shallowFoamSlopeRange > 0 &&
    p.shallowNormalHeightScale >= 0
  );
}

function validFluidWaveParameters(p: WaterFluidRecipe['parameters']): boolean {
  return (
    p.evaporationMPerSecond >= 0 &&
    p.normalHeightScale >= 0 &&
    p.waveNormalAmount >= 0 &&
    p.waveHeightDivisorM > 0 &&
    p.waveEdgeFalloff > 0 &&
    p.waveEdgeFalloff <= 0.5
  );
}

function validFluidNormalParameters(p: WaterFluidRecipe['parameters']): boolean {
  return (
    p.normalDefaultDepthM >= 0 &&
    p.normalFoamAmount >= 0 &&
    p.normalFoamHeightScale >= 0 &&
    p.normalEdgeFalloff > 0 &&
    p.normalEdgeFalloff <= 0.5
  );
}

function validFluidFoamParameters(p: WaterFluidRecipe['parameters']): boolean {
  return (
    p.foamFadePerFrame >= 0 &&
    p.foamFadePerFrame <= 1 &&
    p.foamDiffusion >= 0 &&
    p.foamDiffusion <= 1 &&
    p.foamEdgeFalloff > 0 &&
    p.foamEdgeFalloff <= 0.5 &&
    p.foamWetPerMeter >= 0 &&
    p.foamWetFadePerFrame >= 0 &&
    p.foamWetFadePerFrame <= 1 &&
    p.foamToneMapDensity >= 0 &&
    p.maskThreshold >= 0 &&
    p.maskThreshold < 1
  );
}

function validFluidInjectionLimits(value: Record<string, unknown>): boolean {
  if (!closed(value.injectionLimits, ['heightDeltaM', 'foamStrength'])) return false;
  for (const [name, unit] of [
    ['heightDeltaM', 'm'],
    ['foamStrength', 'unitless'],
  ] as const) {
    const limit = value.injectionLimits[name];
    if (
      !closed(limit, ['encodedRange', 'unit']) ||
      limit.unit !== unit ||
      !vector(limit.encodedRange, 2) ||
      limit.encodedRange[0] >= limit.encodedRange[1] ||
      limit.encodedRange[0] > 0 ||
      limit.encodedRange[1] < 0
    )
      return false;
  }
  return true;
}

function validFluidInstanceIdentity(
  input: WaterFluidInstanceInput,
  seen: ReadonlySet<string>,
  bodies: ReadonlySet<string>,
): boolean {
  return !(
    !input.instanceId ||
    !input.recipeGuid ||
    !input.recipeVersion ||
    !input.bodyGuid ||
    seen.has(input.instanceId) ||
    (input.enabled && bodies.has(input.bodyGuid)) ||
    !vector([...input.centerM], 3) ||
    !vector([...input.waveFoamCenterM], 3) ||
    !Number.isSafeInteger(input.resetRevision) ||
    input.resetRevision < 0 ||
    !Number.isSafeInteger(input.bodyGeneration) ||
    input.bodyGeneration < 0
  );
}

function validFluidImpulseShape(
  impulse: WaterFluidImpulse,
  limits: WaterFluidRecipe['injectionLimits'],
): boolean {
  const within = (value: number, range: WaterVec2) =>
    Number.isFinite(value) && value >= range[0] && value <= range[1];
  return !(
    !vector([...impulse.positionM], 3) ||
    !Number.isFinite(impulse.radiusM) ||
    impulse.radiusM <= 0 ||
    !within(impulse.heightDeltaM, limits.heightDeltaM.encodedRange) ||
    !within(impulse.foamStrength, limits.foamStrength.encodedRange) ||
    !Number.isFinite(impulse.lifetimeSeconds) ||
    impulse.lifetimeSeconds < 0 ||
    (impulse.kind !== 'direct' && impulse.kind !== 'splash') ||
    (impulse.kind === 'splash' &&
      (impulse.lifetimeSeconds <= 0 ||
        !Number.isFinite(impulse.startOffsetSeconds) ||
        impulse.startOffsetSeconds < 0 ||
        !Number.isFinite(impulse.strengthOverLifePower) ||
        impulse.strengthOverLifePower < 0))
  );
}

function appendActiveFluidDrawImpulses(
  active: readonly WaterFluidActiveImpulse[],
  impulses: WaterFluidDrawImpulse[],
): void {
  for (const impulse of active) {
    const age =
      impulse.elapsedSeconds - (impulse.kind === 'splash' ? impulse.startOffsetSeconds : 0);
    if (impulse.kind === 'splash' && age < 0) continue;
    const factor =
      impulse.kind === 'direct'
        ? 1
        : Math.min(Math.max(age / impulse.lifetimeSeconds, 0), 1) ** impulse.strengthOverLifePower;
    impulses.push({
      positionM: impulse.positionM,
      radiusM: impulse.radiusM,
      heightDeltaM: impulse.heightDeltaM * factor,
      foamStrength: impulse.foamStrength,
      sequence: impulse.sequence,
    });
  }
}

function staleFluidSubmission(
  instance: Instance,
  frame: WaterFluidFrame,
  sameDevice: boolean,
  step: number,
): boolean {
  return (
    instance.generation !== frame.simulationGeneration ||
    instance.signature !== instanceSignature(frame.instance) ||
    (sameDevice &&
      instance.submitted !== undefined &&
      instance.submitted.sourceFrame >= frame.sourceFrame) ||
    (sameDevice && step > (frame.steps.at(-1)?.fixedStep ?? frame.baseStep)) ||
    (instance.submitted !== undefined &&
      instance.submitted.deviceGeneration > frame.deviceGeneration) ||
    (instance.submitted !== undefined && instance.submitted.timeSeconds > frame.timeSeconds)
  );
}

function fluidLastSubmittedStep(base: WaterFluidFrame | undefined): number {
  return base?.steps.at(-1)?.fixedStep ?? base?.baseStep ?? 0;
}
function fluidConsumedImpulseSequence(
  pending: readonly WaterFluidQueuedImpulse[],
  prior: WaterFluidFrame | undefined,
): number {
  return pending.at(-1)?.sequence ?? prior?.consumedImpulseSequence ?? 0;
}
