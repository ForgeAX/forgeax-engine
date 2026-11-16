import { AssetGuid } from '@forgeax/engine-pack/source';
import {
  canonicalJson,
  err,
  ok,
  type Result,
  sha256,
  type WaterAdvancedShallowStage,
  type WaterAdvancedSimulationSource,
} from '@forgeax/engine-types';
import { type Vec2, type Vec3, type WaterError, WaterQueryFlags } from './contracts';
import type { WaterSystem } from './system';
import { validateWaterAsset, waterRiverBakeGeometryProjectionHash } from './validate';

export type WaterAdvancedError = Readonly<{
  code:
    | 'water-advanced-invalid-input'
    | 'water-advanced-source-parameter-unavailable'
    | 'water-advanced-stale-generation'
    | 'water-advanced-unsupported'
    | 'water-advanced-stage-failed'
    | 'water-advanced-disabled'
    | 'water-advanced-readback-unavailable'
    | 'water-advanced-bake-unavailable';
  expected: string;
  hint: string;
  detail: Readonly<{ recipeGuid: string; generation: number; cause?: unknown }>;
}>;
export type WaterAdvancedRecipe = Readonly<{
  guid: string;
  contentVersion: string;
  asset: WaterAdvancedSimulationSource & { readonly kind: 'water-simulation-recipe' };
}>;
type ShallowRecipe = WaterAdvancedRecipe & {
  readonly asset: WaterAdvancedRecipe['asset'] & {
    readonly shallowStageConfig: NonNullable<WaterAdvancedRecipe['asset']['shallowStageConfig']>;
  };
};
export type WaterAdvancedBody = Readonly<{
  guid: string;
  sourceAssetGuid: string;
  generation: number;
}>;
export type WaterAdvancedGridTransform = Readonly<{
  centerXZ: Vec2;
  extentM: Vec2;
  yawRadians: number;
  heightOriginM: number;
}>;
export type WaterAdvancedImpact = Readonly<{
  id: number;
  positionM: Vec3;
  velocityMPerSec: Vec3;
  radiusM: number;
  timeSeconds: number;
}>;
export type WaterAdvancedSourceSink = Readonly<{
  id: number;
  enabled: boolean;
  kind: 'source' | 'sink';
  positionM: Vec3;
  extentM: Vec3;
  yawRadians: number;
  additiveVelocity: boolean;
  sinkDissipationPerSecond: number;
  velocityMPerSec: Vec3;
}>;
export type WaterAdvancedWaterInfo =
  | Readonly<{ status: 'pending' | 'unavailable'; bodyGeneration: number }>
  | Readonly<{
      status: 'ready';
      bodyGeneration: number;
      zoneGeneration: number;
      targetName: string;
      targetFormat: 'rgba16float' | 'rgba32float';
      slice: number;
      centerXZ: Vec2;
      extentM: Vec2;
      waterHeightRangeM: Vec2;
      groundHeightRangeM: Vec2;
      maxVelocityMPerSec: number;
    }>;
export type WaterAdvancedFrameInput = Readonly<{
  deltaSeconds: number;
  timeSeconds: number;
  centerXZ: Vec2;
  yawRadians: number;
  pawn?: Readonly<{ positionM: Vec3; velocityMPerSec: Vec3; touchingWater: boolean }>;
}>;
export type WaterAdvancedCollisionSurface =
  | Readonly<{ status: 'disabled' }>
  | Readonly<{
      status: 'pending';
      reason: 'owner-unavailable' | 'body-unavailable' | 'query-unavailable';
      error?: WaterError;
    }>
  | Readonly<{
      status: 'ready';
      bodyGuid: string;
      sourceAssetGuid: string;
      sourceVersion: string;
      bodyGeneration: number;
      sourcePublicationGeneration?: number;
      positionM: Vec3;
      timeSeconds: number;
    }>;
export type WaterAdvancedStageTask = Readonly<{
  stage: WaterAdvancedShallowStage;
  step: number;
  substep: number;
  ordinal: number;
  previousStageOrdinal: number | null;
  deltaSeconds: number;
  reset: boolean;
}>;
export type WaterAdvancedFrame = Readonly<{
  recipe: ShallowRecipe;
  body: WaterAdvancedBody;
  generation: number;
  sequence: number;
  step: number;
  reset: boolean;
  timeSeconds: number;
  deltaSeconds: number;
  transform: WaterAdvancedGridTransform;
  previousTransform: WaterAdvancedGridTransform;
  waterInfo: WaterAdvancedWaterInfo;
  collisionSurface: WaterAdvancedCollisionSurface;
  impacts: readonly WaterAdvancedImpact[];
  sourceSinks: readonly WaterAdvancedSourceSink[];
  stages: readonly WaterAdvancedStageTask[];
  secondsUntilDestroyed: number;
  bakeRequest: number | null;
  /** Body identity, matrix, geometry and lattice frozen when this source frame is formed. */
  bakeCapture?: WaterAdvancedBakeCapture;
  captureStages: boolean;
}>;
export type WaterAdvancedBakeCapture = Readonly<{
  readonly sourceBodyGuid: string;
  readonly sourceBodyGeneration: number;
  readonly sourceWorldMatrixM: readonly number[];
  readonly sourceGeometryProjectionHash: string;
  readonly sourceFrame: Readonly<{
    readonly generation: number;
    readonly sequence: number;
    readonly step: number;
    readonly timeSeconds: number;
  }>;
  readonly lattice: Readonly<{
    readonly width: number;
    readonly height: number;
    readonly originXZ: Vec2;
    readonly originYM: number;
    readonly spacingXZ: Vec2;
  }>;
}>;
export type WaterAdvancedLifecycle =
  | 'disabled'
  | 'waiting-water-info'
  | 'waiting-water-surface'
  | 'initializing'
  | 'active'
  | 'fading'
  | 'retired'
  | 'unsupported'
  | 'failed';
export type WaterAdvancedCompletion = Readonly<{
  frameId: number;
  deviceGeneration: number;
  graphGeneration: number;
}>;
export type WaterAdvancedTextureReadback = Readonly<{
  name: string;
  format: 'rgba16float' | 'rgba32float' | 'rgba8unorm';
  width: number;
  height: number;
  bytesPerRow: number;
  bytes: Uint8Array;
  completion: WaterAdvancedCompletion;
  sourceFrame?: Readonly<{
    generation: number;
    sequence: number;
    step: number;
    timeSeconds: number;
  }>;
}>;
export type WaterAdvancedBakeReadback = Readonly<{
  frame: WaterAdvancedFrame;
  gridPixels: WaterAdvancedTextureReadback;
  normalPixels: WaterAdvancedTextureReadback;
  completion: WaterAdvancedCompletion;
}>;
export type WaterAdvancedInspection = Readonly<{
  recipeGuid: string;
  body: WaterAdvancedBody;
  generation: number;
  status: WaterAdvancedLifecycle;
  step: number;
  submittedSequence: number;
  completedSequence: number;
  previousStage: WaterAdvancedShallowStage | null;
  queuedImpacts: number;
  sourceSinkCount: number;
  transform: WaterAdvancedGridTransform;
  previousTransform: WaterAdvancedGridTransform;
  waterInfo: WaterAdvancedWaterInfo['status'];
  collisionSurface: WaterAdvancedCollisionSurface;
  secondsUntilDestroyed: number;
  bake: Readonly<{
    status: 'idle' | 'requested' | 'reading' | 'captured' | 'published' | 'failed';
    request: number;
    error?: WaterAdvancedError;
  }>;
  completion?: WaterAdvancedCompletion;
  readbackError?: WaterAdvancedError;
  error?: WaterAdvancedError;
}>;

const RESET_STAGES = ['Create Vertices', 'Create Triangles', 'Init'] as const;
const CORE_STAGES = [
  'Extrapolate Velocities',
  'Advect Water',
  'Extrapolate Height',
  'Update Velocity',
  'Update Depth',
] as const;
const finiteVector = (value: readonly number[], length: number) =>
  value.length === length && value.every(Number.isFinite);
const copy2 = (value: Vec2): Vec2 => Object.freeze([value[0], value[1]]);
const copy3 = (value: Vec3): Vec3 => Object.freeze([value[0], value[1], value[2]]);
const freezeTransform = (value: WaterAdvancedGridTransform): WaterAdvancedGridTransform =>
  Object.freeze({ ...value, centerXZ: copy2(value.centerXZ), extentM: copy2(value.extentM) });
function freezeRecipe<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeRecipe(child);
    Object.freeze(value);
  }
  return value;
}
export function waterAdvancedOutputNames(
  recipeGuid: string,
  bodyGuid: string,
  worldIdentity: string,
) {
  const identity = sha256(canonicalJson([recipeGuid, bodyGuid, worldIdentity]));
  const prefix = `water-advanced-${identity}`;
  return Object.freeze({
    prefix,
    grid: `${prefix}-source-grid-local16`,
    normal: `${prefix}-normal`,
    materialGrid: `${prefix}-material-grid-world32-history`,
    materialNormal: `${prefix}-material-normal-history`,
    foam: `${prefix}-foam`,
    mapping: `${prefix}-mapping`,
    previousGrid: `${prefix}-previous-grid`,
    previousNormal: `${prefix}-previous-normal`,
    previousMapping: `${prefix}-previous-mapping`,
    bake: `${prefix}-river-bake`,
  });
}

type AppendStage = (
  stage: WaterAdvancedShallowStage,
  substep: number,
  deltaSeconds: number,
) => void;

function appendSimulationStages(
  config: NonNullable<WaterAdvancedSimulationSource['shallowStageConfig']>,
  numSteps: number,
  dt: number,
  add: AppendStage,
): void {
  const river = config.stageProfile === 'ue-5.8.1-river';
  if (river) {
    add('Pre Sim', 0, dt);
    add('River Source and Sink', 0, dt);
    if (config.distributeOverlapVolume) add('Distribute Overlap Volume', 0, dt);
  }
  for (let substep = 0; substep < numSteps; substep++) {
    if (!river) {
      add('Pre Sim', substep, dt);
      if (config.distributeOverlapVolume) add('Distribute Overlap Volume', substep, dt);
    }
    for (const stage of CORE_STAGES) add(stage, substep, dt);
  }
  add('Post Sim', 0, dt);
  add('Compute Normals', 0, dt);
}

/** The profile owns order and loop boundaries; authored recipes cannot reorder the solver. */
function waterAdvancedStageTasks(
  recipe: WaterAdvancedSimulationSource,
  reset: boolean,
  step: number,
  frameDeltaSeconds: number,
  maximumDeltaSeconds: number,
): readonly WaterAdvancedStageTask[] {
  const config = recipe.shallowStageConfig;
  const substeps = recipe.substepConfig;
  if (!config || !substeps || !recipe.enabledFeatures.includes('shallow')) return [];
  const river = config.stageProfile === 'ue-5.8.1-river';
  const rows: WaterAdvancedStageTask[] = [];
  const dt =
    Math.min(frameDeltaSeconds / substeps.numSteps, maximumDeltaSeconds) * substeps.simSpeed;
  const add = (stage: WaterAdvancedShallowStage, substep: number, deltaSeconds: number) => {
    const ordinal = rows.length;
    rows.push(
      Object.freeze({
        stage,
        step,
        substep,
        ordinal,
        previousStageOrdinal: ordinal === 0 ? null : ordinal - 1,
        deltaSeconds,
        reset,
      }),
    );
  };
  const appendCoreStages = (): void => {
    if (reset) {
      for (const stage of RESET_STAGES)
        if (stage === 'Init' || river || config.beautyEnabled) add(stage, 0, 0);
      if (river) add('Init Foam', 0, 0);
    } else if (!river || config.runLiveSimulation)
      appendSimulationStages(config, substeps.numSteps, dt, add);
  };
  const appendPresentationStages = (): void => {
    if (!reset && config.debug.enabled && config.debug.writers.length > 0) add('Prep Debug', 0, dt);
    if (!reset && config.beautyEnabled && !river) add('Prep Debug Beauty', 0, dt);
    if ((river && config.runLiveSimulation) || recipe.enabledFeatures.includes('shallowFoam')) {
      add('Foam', 0, frameDeltaSeconds);
      if (river) add('Live Sim - Blur Normals', 0, dt);
    }
  };
  appendCoreStages();
  appendPresentationStages();
  return Object.freeze(rows);
}

function validFrameInput(input: WaterAdvancedFrameInput): boolean {
  return !(
    !Number.isFinite(input.deltaSeconds) ||
    input.deltaSeconds < 0 ||
    !Number.isFinite(input.timeSeconds) ||
    input.timeSeconds < 0 ||
    !finiteVector(input.centerXZ, 2) ||
    input.yawRadians !== 0 ||
    (input.pawn &&
      (!finiteVector(input.pawn.positionM, 3) ||
        !finiteVector(input.pawn.velocityMPerSec, 3) ||
        typeof input.pawn.touchingWater !== 'boolean'))
  );
}

/** Scene-owned intent/state only. No GPU handle or mutable simulation grid crosses this boundary. */
export class WaterAdvancedSimulation {
  readonly recipe: ShallowRecipe;
  readonly body: WaterAdvancedBody;
  #generation = 1;
  #sequence = 0;
  #step = 0;
  #status: WaterAdvancedLifecycle = 'initializing';
  #enabled = true;
  #reset = true;
  #impacts: WaterAdvancedImpact[] = [];
  #sourceSinks: readonly WaterAdvancedSourceSink[] = [];
  #lastWaterOverlap: number | undefined;
  #secondsUntilDestroyed = 15;
  #input: WaterAdvancedFrameInput | undefined;
  #waterInfo: WaterAdvancedWaterInfo;
  #collisionSurface: WaterAdvancedCollisionSurface = { status: 'disabled' };
  #transform: WaterAdvancedGridTransform;
  #previousTransform: WaterAdvancedGridTransform;
  #pending: WaterAdvancedFrame | undefined;
  #submittedSequence = 0;
  #completedSequence = 0;
  #previousStage: WaterAdvancedShallowStage | null = null;
  #completion: WaterAdvancedCompletion | undefined;
  #captureCompletions = new Map<number, WaterAdvancedCompletion>();
  #error: WaterAdvancedError | undefined;
  #bake: WaterAdvancedInspection['bake'] = { status: 'idle', request: 0 };
  #captureStages = false;
  #readbacks: readonly WaterAdvancedTextureReadback[] = [];
  #bakeReadback: WaterAdvancedBakeReadback | undefined;
  #readbackError: WaterAdvancedError | undefined;

  private constructor(
    recipe: ShallowRecipe,
    body: WaterAdvancedBody,
    private readonly maximumDeltaSeconds: number,
    private readonly waterSystem: WaterSystem | undefined,
  ) {
    this.recipe = freezeRecipe(structuredClone(recipe));
    this.body = Object.freeze({ ...body });
    this.#waterInfo = { status: 'pending', bodyGeneration: body.generation };
    this.#transform = freezeTransform({
      centerXZ: [0, 0],
      extentM: recipe.asset.shallowStageConfig.extentM,
      yawRadians: 0,
      heightOriginM: recipe.asset.shallowStageConfig.baseHeightM,
    });
    this.#previousTransform = this.#transform;
  }

  static create(
    recipe: WaterAdvancedRecipe,
    body: WaterAdvancedBody,
    waterSystem?: WaterSystem,
  ): Result<WaterAdvancedSimulation, WaterAdvancedError> {
    const source = validateWaterAsset(recipe.asset);
    if (
      !source.ok ||
      !AssetGuid.parse(recipe.guid).ok ||
      !recipe.contentVersion ||
      !body.guid ||
      !AssetGuid.parse(body.sourceAssetGuid).ok ||
      !Number.isSafeInteger(body.generation) ||
      body.generation <= 0 ||
      (recipe.asset.riverBakeConfig &&
        recipe.asset.riverBakeConfig.sourceBodyGuid !== body.sourceAssetGuid)
    )
      return err({
        code: 'water-advanced-invalid-input',
        expected: 'one validated versioned WaterAdvanced recipe and mounted Body generation',
        hint: 'load the recipe through Pack/Catalog and use the current Body snapshot',
        detail: { recipeGuid: recipe.guid, generation: 1, cause: source.ok ? body : source.error },
      });
    const shallowStageConfig = recipe.asset.shallowStageConfig;
    if (!recipe.asset.enabledFeatures.includes('shallow') || shallowStageConfig === undefined)
      return err({
        code: 'water-advanced-invalid-input',
        expected: 'a shallow-enabled recipe for a Body simulation',
        hint: 'request OceanPatch through WaterSystem instead',
        detail: { recipeGuid: recipe.guid, generation: 1 },
      });
    const limit = recipe.asset.substepConfig?.deltaLimit;
    if (limit?.kind !== 'application-cap')
      return err({
        code: 'water-advanced-source-parameter-unavailable',
        expected:
          'an explicit application-cap because the effective UE source timestep cap is unpaired',
        hint: 'author substepConfig.deltaLimit with kind application-cap and a positive maximumDeltaSeconds',
        detail: {
          recipeGuid: recipe.guid,
          generation: 1,
          cause: { parameter: 'substepConfig.deltaLimit', mode: 'source-default' },
        },
      });
    return ok(
      new WaterAdvancedSimulation(
        { ...recipe, asset: { ...recipe.asset, shallowStageConfig } },
        body,
        limit.maximumDeltaSeconds,
        waterSystem,
      ),
    );
  }

  #captureCollisionSurface(input: WaterAdvancedFrameInput): WaterAdvancedCollisionSurface {
    if (this.recipe.asset.shallowStageConfig?.rigidMeshCollisions.kind === 'disabled')
      return Object.freeze({ status: 'disabled' });
    const system = this.waterSystem;
    if (system === undefined)
      return Object.freeze({ status: 'pending', reason: 'owner-unavailable' });
    const snapshot = system.snapshot(this.body.guid);
    if (
      snapshot?.sceneGeneration !== this.body.generation ||
      snapshot.sourceAssetGuid !== this.body.sourceAssetGuid
    )
      return Object.freeze({ status: 'pending', reason: 'body-unavailable' });
    const heightOriginM = snapshot.worldMatrixM[13];
    if (heightOriginM === undefined)
      return Object.freeze({ status: 'pending', reason: 'body-unavailable' });
    const positionM: Vec3 = input.pawn?.positionM ?? [
      input.centerXZ[0],
      heightOriginM,
      input.centerXZ[1],
    ];
    const query = system.queryBody(this.body.guid, {
      positionM,
      timeSeconds: input.timeSeconds,
      flags: WaterQueryFlags.ComputeLocation,
      expectedBodyGeneration: this.body.generation,
    });
    if (!query.ok)
      return Object.freeze({ status: 'pending', reason: 'query-unavailable', error: query.error });
    if (!query.value.valid.has('location') || query.value.excluded || !query.value.surfaceM)
      return Object.freeze({ status: 'pending', reason: 'query-unavailable' });
    return Object.freeze({
      status: 'ready',
      bodyGuid: snapshot.guid,
      sourceAssetGuid: snapshot.sourceAssetGuid,
      sourceVersion: snapshot.sourceVersion,
      bodyGeneration: snapshot.sceneGeneration,
      ...(snapshot.sourcePublication === undefined
        ? {}
        : { sourcePublicationGeneration: snapshot.sourcePublication.generation }),
      positionM: copy3(query.value.surfaceM),
      timeSeconds: input.timeSeconds,
    });
  }

  failure(code: WaterAdvancedError['code'], expected: string, cause?: unknown): WaterAdvancedError {
    return Object.freeze({
      code,
      expected,
      hint: 'inspect the exact recipe, stage and device generation before retrying or resetting',
      detail: Object.freeze({
        recipeGuid: this.recipe.guid,
        generation: this.#generation,
        ...(cause === undefined ? {} : { cause }),
      }),
    });
  }

  update(input: WaterAdvancedFrameInput): Result<void, WaterAdvancedError> {
    if (this.#status === 'retired')
      return err(this.failure('water-advanced-disabled', 'a live mounted simulation'));
    if (!validFrameInput(input))
      return err(
        this.failure(
          'water-advanced-invalid-input',
          'finite m/XZ/Y inputs and current-generation WaterInfo',
        ),
      );
    this.#input = structuredClone(input);
    this.#collisionSurface = this.#captureCollisionSurface(input);
    const config = this.recipe.asset.shallowStageConfig;
    if (this.#lastWaterOverlap === undefined || input.pawn?.touchingWater)
      this.#lastWaterOverlap = input.timeSeconds;
    this.#secondsUntilDestroyed = config?.followPawn
      ? Math.max(0, 15 - (input.timeSeconds - this.#lastWaterOverlap))
      : 15;
    const center: Vec2 =
      config?.followPawn && input.pawn
        ? [input.pawn.positionM[0], input.pawn.positionM[2]]
        : input.centerXZ;
    this.#transform = freezeTransform({
      ...this.#transform,
      centerXZ: center,
      yawRadians: input.yawRadians,
    });
    if (!this.#enabled) this.#status = 'disabled';
    else if (config?.followPawn && this.#secondsUntilDestroyed === 0) this.retire();
    else if (this.#error)
      this.#status = this.#error.code === 'water-advanced-unsupported' ? 'unsupported' : 'failed';
    else if (this.#collisionSurface.status === 'pending') {
      this.#status = 'waiting-water-surface';
      this.#pending = undefined;
    } else if (config?.waterInfoRequired && this.#waterInfo.status !== 'ready')
      this.#status = 'waiting-water-info';
    else if (!this.#error)
      this.#status = this.#reset
        ? 'initializing'
        : config?.followPawn && this.#secondsUntilDestroyed < 15
          ? 'fading'
          : 'active';
    return ok(undefined);
  }

  bindWaterInfo(waterInfo: WaterAdvancedWaterInfo): void {
    if (waterInfo.bodyGeneration !== this.body.generation) return;
    this.#waterInfo = structuredClone(waterInfo);
    if (!this.#enabled || this.#status === 'retired' || this.#error) return;
    if (this.recipe.asset.shallowStageConfig?.waterInfoRequired && waterInfo.status !== 'ready') {
      this.#status = 'waiting-water-info';
      this.#pending = undefined;
    } else if (this.#status === 'waiting-water-info')
      this.#status =
        this.#collisionSurface.status === 'pending'
          ? 'waiting-water-surface'
          : this.#reset
            ? 'initializing'
            : 'active';
  }

  requestStageCapture(): void {
    this.#captureStages = true;
    this.#readbacks = [];
    this.#readbackError = undefined;
    this.#pending = undefined;
  }
  unavailableReadbacks(
    frame: WaterAdvancedFrame,
    cause?: unknown,
  ): Result<void, WaterAdvancedError> {
    if (
      frame.generation !== this.#generation ||
      (!frame.captureStages && frame.bakeRequest === null)
    )
      return ok(undefined);
    this.#captureCompletions.delete(frame.sequence);
    const error = this.failure(
      'water-advanced-readback-unavailable',
      'completed feature-texture observations delivered to the source owner',
      cause,
    );
    this.#readbackError = error;
    if (frame.bakeRequest !== null)
      this.finishBake(
        frame.bakeRequest,
        this.failure(
          'water-advanced-bake-unavailable',
          'the completed River Bake texture copy',
          cause,
        ),
      );
    return err(error);
  }
  textureReadbacks(): readonly WaterAdvancedTextureReadback[] {
    return structuredClone(this.#readbacks);
  }
  bakeReadback(): WaterAdvancedBakeReadback | undefined {
    return this.#bakeReadback === undefined ? undefined : structuredClone(this.#bakeReadback);
  }
  acceptReadbacks(
    frame: WaterAdvancedFrame,
    readbacks: readonly WaterAdvancedTextureReadback[],
  ): Result<void, WaterAdvancedError> {
    if (!frame.captureStages && frame.bakeRequest === null) return ok(undefined);
    const completion = this.#captureCompletions.get(frame.sequence);
    if (
      frame.generation !== this.#generation ||
      !completion ||
      readbacks.some(
        (readback) =>
          readback.completion.frameId !== completion.frameId ||
          readback.completion.deviceGeneration !== completion.deviceGeneration ||
          readback.completion.graphGeneration !== completion.graphGeneration,
      )
    )
      return err(
        this.failure(
          'water-advanced-stale-generation',
          'readbacks from their exact completed simulation frame and current device generation',
        ),
      );
    this.#captureCompletions.delete(frame.sequence);
    if (readbacks.length === 0)
      return this.unavailableReadbacks(frame, { reason: 'no-feature-texture-observations' });
    this.#readbackError = undefined;
    const capturedReadbacks = structuredClone(
      readbacks.map((row) => ({
        ...row,
        sourceFrame: {
          generation: frame.generation,
          sequence: frame.sequence,
          step: frame.step,
          timeSeconds: frame.timeSeconds,
        },
      })),
    );
    this.#readbacks = capturedReadbacks;
    if (frame.bakeRequest !== null && this.#bake.request === frame.bakeRequest) {
      const gridPixels = capturedReadbacks.find((readback) =>
        readback.name.endsWith('-river-bake'),
      );
      const normalPixels = capturedReadbacks.find((readback) =>
        readback.name.endsWith('-river-bake-normal'),
      );
      if (gridPixels === undefined || normalPixels === undefined) {
        this.finishBake(
          frame.bakeRequest,
          this.failure(
            'water-advanced-bake-unavailable',
            'the completed River Bake grid and direct solver-normal texture copies from the same frame',
          ),
        );
        return ok(undefined);
      }
      this.#bakeReadback = structuredClone({
        frame,
        gridPixels,
        normalPixels,
        completion: gridPixels.completion,
      });
      this.#bake = { status: 'captured', request: frame.bakeRequest };
    }
    return ok(undefined);
  }

  enqueueImpact(impact: WaterAdvancedImpact): Result<void, WaterAdvancedError> {
    if (!this.#enabled || this.#status === 'retired')
      return err(
        this.failure('water-advanced-disabled', 'a live enabled simulation for collision input'),
      );
    if (
      !Number.isSafeInteger(impact.id) ||
      impact.id < 0 ||
      !finiteVector(impact.positionM, 3) ||
      !finiteVector(impact.velocityMPerSec, 3) ||
      !Number.isFinite(impact.radiusM) ||
      impact.radiusM <= 0 ||
      !Number.isFinite(impact.timeSeconds) ||
      impact.timeSeconds < 0 ||
      this.#impacts.length >= 128
    )
      return err(
        this.failure(
          'water-advanced-invalid-input',
          'a finite world-space collision impact and bounded 128-entry NDC queue',
        ),
      );
    if (this.#impacts.some((value) => value.id === impact.id)) return ok(undefined);
    this.#impacts.push(
      Object.freeze({
        ...impact,
        positionM: copy3(impact.positionM),
        velocityMPerSec: copy3(impact.velocityMPerSec),
      }),
    );
    return ok(undefined);
  }

  setSourceSinks(values: readonly WaterAdvancedSourceSink[]): Result<void, WaterAdvancedError> {
    if (this.#status === 'retired')
      return err(
        this.failure('water-advanced-disabled', 'a live simulation for source and sink input'),
      );
    if (
      values.length > 64 ||
      new Set(values.map((value) => value.id)).size !== values.length ||
      values.some(
        (value) =>
          !Number.isSafeInteger(value.id) ||
          value.id < 0 ||
          typeof value.enabled !== 'boolean' ||
          !['source', 'sink'].includes(value.kind) ||
          !finiteVector(value.positionM, 3) ||
          !finiteVector(value.velocityMPerSec, 3) ||
          !finiteVector(value.extentM, 3) ||
          value.extentM.some((component) => component <= 0) ||
          !Number.isFinite(value.yawRadians) ||
          typeof value.additiveVelocity !== 'boolean' ||
          !Number.isFinite(value.sinkDissipationPerSecond) ||
          value.sinkDissipationPerSecond < 0,
      )
    )
      return err(
        this.failure(
          'water-advanced-invalid-input',
          'at most 64 uniquely identified finite River sources and sinks',
        ),
      );
    this.#sourceSinks = Object.freeze(
      values.map((value) =>
        Object.freeze({
          ...value,
          positionM: copy3(value.positionM),
          extentM: copy3(value.extentM),
          velocityMPerSec: copy3(value.velocityMPerSec),
        }),
      ),
    );
    return ok(undefined);
  }

  setEnabled(enabled: boolean): void {
    if (this.#status === 'retired') return;
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    if (enabled) this.reset();
    else {
      this.#generation++;
      this.#status = 'disabled';
      this.#pending = undefined;
      this.#impacts = [];
      this.#captureCompletions.clear();
      this.#readbacks = [];
      this.#bakeReadback = undefined;
      this.#captureStages = false;
      this.#bake = { status: 'idle', request: this.#bake.request };
      this.#completion = undefined;
      this.#readbackError = undefined;
    }
  }

  reset(): void {
    if (this.#status === 'retired') return;
    this.#generation++;
    this.#reset = true;
    this.#pending = undefined;
    this.#step = 0;
    this.#error = undefined;
    this.#completion = undefined;
    this.#captureCompletions.clear();
    this.#impacts = [];
    this.#previousStage = null;
    this.#bakeReadback = undefined;
    this.#readbacks = [];
    this.#readbackError = undefined;
    this.#bake = { status: 'idle', request: this.#bake.request };
    this.#previousTransform = this.#transform;
    this.#status = this.#enabled ? 'initializing' : 'disabled';
  }

  requestBake(): Result<number, WaterAdvancedError> {
    if (
      !this.#enabled ||
      !this.recipe.asset.enabledFeatures.includes('riverBake') ||
      this.#reset ||
      ['waiting-water-info', 'waiting-water-surface', 'retired', 'failed', 'unsupported'].includes(
        this.#status,
      )
    )
      return err(
        this.failure(
          'water-advanced-bake-unavailable',
          'an active initialized River with riverBake enabled',
        ),
      );
    if (
      this.#bake.status === 'requested' ||
      this.#bake.status === 'reading' ||
      this.#bake.status === 'captured'
    )
      return ok(this.#bake.request);
    this.#bake = { status: 'requested', request: this.#bake.request + 1 };
    this.#pending = undefined;
    return ok(this.#bake.request);
  }

  frame(): WaterAdvancedFrame | undefined {
    if (
      !this.#enabled ||
      !this.#input ||
      this.#collisionSurface.status === 'pending' ||
      ['waiting-water-info', 'waiting-water-surface', 'retired', 'failed', 'unsupported'].includes(
        this.#status,
      )
    )
      return undefined;
    if (!this.recipe.asset.enabledFeatures.includes('shallow')) return undefined;
    if (this.#pending) return this.#pending;
    const input = this.#input;
    const sequence = this.#sequence + 1;
    const step = this.#step + 1;
    const bakeRequest = this.#bake.status === 'requested' ? this.#bake.request : null;
    const bakeCapture =
      bakeRequest === null ? undefined : this.captureBakeSource(input, sequence, step);
    this.#pending = Object.freeze({
      recipe: this.recipe,
      body: this.body,
      generation: this.#generation,
      sequence: ++this.#sequence,
      step,
      reset: this.#reset,
      timeSeconds: input.timeSeconds,
      deltaSeconds: input.deltaSeconds,
      transform: this.#transform,
      previousTransform: this.#previousTransform,
      waterInfo: structuredClone(this.#waterInfo),
      collisionSurface: this.#collisionSurface,
      impacts: Object.freeze(this.#reset ? [] : [...this.#impacts]),
      sourceSinks: this.#sourceSinks,
      stages: waterAdvancedStageTasks(
        this.recipe.asset,
        this.#reset,
        this.#step + 1,
        input.deltaSeconds,
        this.maximumDeltaSeconds,
      ),
      secondsUntilDestroyed: this.#secondsUntilDestroyed,
      bakeRequest,
      ...(bakeCapture === undefined ? {} : { bakeCapture }),
      captureStages: this.#captureStages,
    });
    return this.#pending;
  }

  private captureBakeSource(
    input: WaterAdvancedFrameInput,
    sequence: number,
    step: number,
  ): WaterAdvancedBakeCapture | undefined {
    const snapshot = this.waterSystem?.snapshot(this.body.guid);
    const config = this.recipe.asset.riverBakeConfig;
    const shallow = this.recipe.asset.shallowStageConfig;
    const geometryHash = snapshot && waterRiverBakeGeometryProjectionHash(snapshot.asset);
    if (
      !snapshot ||
      !config ||
      !shallow ||
      snapshot.sceneGeneration !== this.body.generation ||
      snapshot.sourceAssetGuid.toLowerCase() !== this.body.sourceAssetGuid.toLowerCase() ||
      config.sourceBodyGuid.toLowerCase() !== snapshot.sourceAssetGuid.toLowerCase() ||
      !geometryHash ||
      snapshot.worldMatrixM.length !== 16 ||
      !snapshot.worldMatrixM.every(Number.isFinite) ||
      this.#transform.yawRadians !== 0 ||
      this.#transform.extentM.some((value, index) => value !== config.bakeExtentM[index])
    )
      return undefined;
    const width = shallow.gridResolution[0];
    const height = shallow.gridResolution[1];
    const spacingXZ: Vec2 = [config.bakeExtentM[0] / width, config.bakeExtentM[1] / height];
    return Object.freeze({
      sourceBodyGuid: snapshot.sourceAssetGuid,
      sourceBodyGeneration: snapshot.sceneGeneration,
      sourceWorldMatrixM: Object.freeze([...snapshot.worldMatrixM]),
      sourceGeometryProjectionHash: geometryHash,
      sourceFrame: Object.freeze({
        generation: this.#generation,
        sequence,
        step,
        timeSeconds: input.timeSeconds,
      }),
      lattice: Object.freeze({
        width,
        height,
        originXZ: copy2([
          this.#transform.centerXZ[0] - config.bakeExtentM[0] / 2 + spacingXZ[0] / 2,
          this.#transform.centerXZ[1] - config.bakeExtentM[1] / 2 + spacingXZ[1] / 2,
        ]),
        originYM: this.#transform.heightOriginM,
        spacingXZ: copy2(spacingXZ),
      }),
    });
  }

  submitted(
    frame: WaterAdvancedFrame,
    executedStageCount: number,
  ): Result<void, WaterAdvancedError> {
    if (frame.generation !== this.#generation || frame.sequence !== this.#pending?.sequence)
      return err(
        this.failure('water-advanced-stale-generation', 'the pending complete simulation step'),
      );
    if (executedStageCount !== frame.stages.length)
      return err(
        this.failure(
          'water-advanced-stage-failed',
          'every enabled stage in one step reaches the same submission',
          { expected: frame.stages.length, actual: executedStageCount },
        ),
      );
    this.#submittedSequence = frame.sequence;
    this.#step = frame.step;
    this.#previousStage = frame.stages.at(-1)?.stage ?? null;
    this.#previousTransform = frame.transform;
    this.#reset = false;
    if (!frame.reset) {
      const consumed = new Set(frame.impacts.map((value) => value.id));
      this.#impacts = this.#impacts.filter((value) => !consumed.has(value.id));
    }
    if (frame.captureStages) this.#captureStages = false;
    if (frame.bakeRequest !== null) this.#bake = { status: 'reading', request: frame.bakeRequest };
    this.#pending = undefined;
    return ok(undefined);
  }

  completed(
    frame: WaterAdvancedFrame,
    completion: WaterAdvancedCompletion,
  ): Result<void, WaterAdvancedError> {
    if (
      frame.generation !== this.#generation ||
      frame.sequence > this.#submittedSequence ||
      ![completion.frameId, completion.deviceGeneration, completion.graphGeneration].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      return err(
        this.failure(
          'water-advanced-stale-generation',
          'completion from a submitted frame in the current simulation generation',
        ),
      );
    if (frame.captureStages || frame.bakeRequest !== null)
      this.#captureCompletions.set(frame.sequence, Object.freeze({ ...completion }));
    if (frame.sequence <= this.#completedSequence) return ok(undefined);
    this.#completedSequence = frame.sequence;
    this.#completion = Object.freeze({ ...completion });
    return ok(undefined);
  }

  finishBake(request: number, error?: WaterAdvancedError): void {
    if (request !== this.#bake.request) return;
    this.#bake = Object.freeze({
      status: error ? 'failed' : 'published',
      request,
      ...(error ? { error } : {}),
    });
  }

  fail(error: WaterAdvancedError): void {
    this.#error = error;
    this.#status = error.code === 'water-advanced-unsupported' ? 'unsupported' : 'failed';
    this.#pending = undefined;
  }

  deviceLost(): void {
    if (this.#status !== 'retired') this.reset();
  }
  retire(): void {
    if (this.#status === 'retired') return;
    this.#generation++;
    this.#status = 'retired';
    this.#enabled = false;
    this.#pending = undefined;
    this.#input = undefined;
    this.#impacts = [];
    this.#sourceSinks = [];
    this.#captureCompletions.clear();
    this.#readbacks = [];
    this.#bakeReadback = undefined;
    this.#captureStages = false;
    this.#bake = { status: 'idle', request: this.#bake.request };
    this.#completion = undefined;
    this.#readbackError = undefined;
  }

  inspect(): WaterAdvancedInspection {
    return Object.freeze({
      recipeGuid: this.recipe.guid,
      body: this.body,
      generation: this.#generation,
      status: this.#status,
      step: this.#step,
      submittedSequence: this.#submittedSequence,
      completedSequence: this.#completedSequence,
      previousStage: this.#previousStage,
      queuedImpacts: this.#impacts.length,
      sourceSinkCount: this.#sourceSinks.length,
      transform: this.#transform,
      previousTransform: this.#previousTransform,
      waterInfo: this.#waterInfo.status,
      collisionSurface: this.#collisionSurface,
      secondsUntilDestroyed: this.#secondsUntilDestroyed,
      bake: this.#bake,
      ...(this.#completion ? { completion: this.#completion } : {}),
      ...(this.#readbackError ? { readbackError: this.#readbackError } : {}),
      ...(this.#error ? { error: this.#error } : {}),
    });
  }
}
