import { AssetGuid } from '@forgeax/engine-pack/source';
import { canonicalJson, err, ok, type Result, sha256 } from '@forgeax/engine-types';
import type {
  WaterAdvancedCompletion,
  WaterAdvancedError,
  WaterAdvancedRecipe,
  WaterAdvancedTextureReadback,
} from './advanced-simulation';
import type { Vec3, WaterError, WaterQueryInput, WaterQueryResult } from './contracts';
import {
  composeWaterQueryResidual,
  residualQueryFailure,
  type WaterResidualQueryBinding,
  type WaterResidualQueryDomain,
  type WaterResidualQueryError,
  type WaterResidualQueryField,
  type WaterResidualQueryReceiver,
  type WaterResidualQueryRegion,
  type WaterResidualQuerySource,
} from './query-residual';
import { validateWaterAsset } from './validate';

type OceanRecipe = WaterAdvancedRecipe & {
  readonly asset: WaterAdvancedRecipe['asset'] & {
    readonly oceanPatchConfig: NonNullable<WaterAdvancedRecipe['asset']['oceanPatchConfig']>;
  };
};

function hasOceanPatchConfig(recipe: WaterAdvancedRecipe): recipe is OceanRecipe {
  return recipe.asset.oceanPatchConfig !== undefined;
}

function freezeRecipe<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeRecipe(child);
    Object.freeze(value);
  }
  return value;
}

export type WaterOceanPatchState =
  | Readonly<{ status: 'disabled' | 'retired' }>
  | Readonly<{
      status: 'initializing';
      generation: number;
      allocation: 'initial-1x1' | 'resolution-requested';
      requestedSize: number;
    }>
  | Readonly<{
      status: 'ready' | 'paused' | 'stale';
      generation: number;
      size: number;
      deviceGeneration: number;
      completedFrame?: number;
    }>
  | Readonly<{
      status: 'unsupported' | 'unavailable';
      generation: number;
      error: WaterAdvancedError;
    }>;
export type WaterOceanPatchFrame = Readonly<{
  recipe: OceanRecipe;
  generation: number;
  sequence: number;
  timeSeconds: number;
  nativeSourceStep?: number;
  nativeSourceTimeSeconds?: number;
  paused: boolean;
  reset: boolean;
  reseedSource: boolean;
  sourceRevision: number;
  noiseRevision: number | null;
  visualNormalDetailFft?: Readonly<{
    revision: number;
    noiseRevision: number | null;
    reset: boolean;
  }>;
  captureStages: boolean;
  captureRequest: number | null;
  queryReceivers?: readonly WaterResidualQueryReceiver[];
  queryFeedback?: WaterResidualQueryRegion &
    Readonly<{
      binding: WaterResidualQueryBinding;
      lifecycleRevision: number;
      receivers?: readonly WaterResidualQueryReceiver[];
    }>;
}>;
export type WaterOceanPatchTextureReadback = Omit<WaterAdvancedTextureReadback, 'sourceFrame'> &
  Readonly<{
    sourceFrame: Pick<
      WaterOceanPatchFrame,
      'generation' | 'sequence' | 'timeSeconds' | 'nativeSourceStep'
    >;
  }>;
export type WaterOceanPatchInspection = Readonly<{
  recipeGuid: string;
  recipeVersion: string;
  generation: number;
  state: WaterOceanPatchState;
  timeSeconds: number;
  noiseRevision: number | null;
  visualNormalDetailFft?: Readonly<{
    revision: number;
    noiseRevision: number | null;
    valid: boolean;
    error?: WaterAdvancedError;
    output?: Readonly<{
      generation: number;
      revision: number;
      noiseRevision: number | null;
      size: number;
      completion: WaterAdvancedCompletion;
    }>;
  }>;
  submittedSequence: number;
  completedSequence: number;
  events: readonly Readonly<{
    event: 'created-1x1' | 'requested-resolution' | 'ready' | 'paused' | 'reset' | 'retired';
    generation: number;
    size: number;
    deviceGeneration?: number;
  }>[];
  completion?: WaterAdvancedCompletion;
  readbackError?: WaterAdvancedError;
  queryFeedback: Readonly<{
    binding?: WaterResidualQueryBinding;
    inFlight: number;
    maximumInFlight: 3;
    maximumBytesPerFrame: number;
    skipped: number;
    completed: number;
    bytesReceived: number;
    error?: WaterError;
    accepted?: Omit<WaterResidualQueryField, 'heightsM'>;
  }>;
}>;

/** Bounded live facts needed to declare the OceanPatch's optional query passes. */
export type WaterOceanPatchQueryProfileState = Readonly<{
  readonly recipeGuid: string;
  readonly recipeVersion: string;
  readonly generation: number;
  readonly algorithm: string;
  readonly resolution: number;
  readonly size: number;
  readonly enabled: boolean;
  readonly binding?: WaterResidualQueryBinding;
  readonly receivers: readonly WaterResidualQueryReceiver[];
}>;

export function waterOceanPatchOutputNames(recipeGuid: string, worldIdentity: string) {
  const prefix = `water-ocean-${sha256(canonicalJson([recipeGuid, worldIdentity]))}`;
  return Object.freeze({
    prefix,
    normal: `${prefix}-normal`,
    visualNormal: `${prefix}-visual-normal-detail`,
    materialNormal: `${prefix}-material-normal-history`,
    previousNormal: `${prefix}-previous-normal`,
    grid: `${prefix}-height`,
    previousGrid: `${prefix}-previous-height`,
    materialGrid: `${prefix}-material-height-history`,
    foam: `${prefix}-foam`,
    mapping: `${prefix}-mapping`,
    queryHeight: `${prefix}-query-height`,
    gridMeshVertices: `${prefix}-grid-mesh-vertices`,
    gridMeshTriangles: `${prefix}-grid-mesh-triangles`,
  });
}

/** One World owns the request, clock and receipts; Render alone owns its GPU resources. */
export class WaterOceanPatch {
  readonly recipe: OceanRecipe;
  #generation = 1;
  #sequence = 0;
  #submittedSequence = 0;
  #completedSequence = 0;
  #enabled = true;
  #paused = false;
  #reset = true;
  #timeSeconds = 0;
  #deltaSeconds: number | undefined;
  #nativeSourceTimeSeconds: number | undefined;
  #nativeSourceStep: number | undefined;
  #nativeSourceOwner: object | undefined;
  #sourceRevision = 1;
  #submittedSourceRevision = 0;
  #noiseRevision: number | null = null;
  #visualNoiseRevision: number | null = null;
  #visualRevision = 1;
  #visualOutputValid = false;
  #visualOutput:
    | Readonly<{
        generation: number;
        revision: number;
        noiseRevision: number | null;
        size: number;
        completion: WaterAdvancedCompletion;
      }>
    | undefined;
  #visualError: WaterAdvancedError | undefined;
  #state: WaterOceanPatchState;
  #events: WaterOceanPatchInspection['events'][number][] = [];
  #pending: WaterOceanPatchFrame | undefined;
  #captureRequest = 0;
  #submittedCaptureRequest = 0;
  #issued = new WeakMap<
    WaterOceanPatchFrame,
    {
      submitted: boolean;
      captureStages: boolean;
      reset: boolean;
      references: number;
      completion?: WaterAdvancedCompletion;
      visualNormalDetailFft?: Readonly<{
        revision: number;
        size: number;
        deviceGeneration: number;
      }>;
    }
  >();
  #completion: WaterAdvancedCompletion | undefined;
  #readbacks: readonly WaterOceanPatchTextureReadback[] = [];
  #readbackError: WaterAdvancedError | undefined;
  #queryBinding: WaterResidualQueryBinding | undefined;
  #queryRegion: WaterResidualQueryRegion | undefined;
  #queryField: WaterResidualQueryField | undefined;
  #queryInFlight = new Set<number>();
  #queryReservations = new WeakMap<WaterOceanPatchFrame, { submitted: boolean }>();
  #querySkipped = 0;
  #queryCompleted = 0;
  #queryBytes = 0;
  #queryError: WaterResidualQueryError | undefined;
  #queryRequestCount = 0;
  #queryWorldBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | undefined;
  #queryReceivers: WaterResidualQueryReceiver[] = [];
  #queryLifecycle = 0;

  private constructor(recipe: OceanRecipe) {
    this.recipe = freezeRecipe(structuredClone(recipe));
    this.#state = {
      status: 'initializing',
      generation: 1,
      allocation: 'initial-1x1',
      requestedSize: recipe.asset.oceanPatchConfig.fftResolution,
    };
  }
  static create(recipe: WaterAdvancedRecipe): Result<WaterOceanPatch, WaterAdvancedError> {
    const valid = validateWaterAsset(recipe.asset);
    if (
      !valid.ok ||
      !AssetGuid.parse(recipe.guid).ok ||
      !recipe.contentVersion ||
      !recipe.asset.enabledFeatures.includes('oceanPatch') ||
      !hasOceanPatchConfig(recipe)
    )
      return err({
        code: 'water-advanced-invalid-input',
        expected: 'one validated versioned OceanPatch recipe',
        hint: 'request the World patch using a loaded recipe with oceanPatch enabled',
        detail: {
          recipeGuid: recipe.guid,
          generation: 1,
          ...(valid.ok ? {} : { cause: valid.error }),
        },
      });
    return ok(new WaterOceanPatch(recipe));
  }
  failure(code: WaterAdvancedError['code'], expected: string, cause?: unknown): WaterAdvancedError {
    return Object.freeze({
      code,
      expected,
      hint: 'inspect the World OceanPatch recipe and current device generation before resetting',
      detail: Object.freeze({
        recipeGuid: this.recipe.guid,
        generation: this.#generation,
        ...(cause === undefined ? {} : { cause }),
      }),
    });
  }
  update(deltaSeconds: number): Result<void, WaterAdvancedError> {
    if (this.#state.status === 'retired')
      return err(this.failure('water-advanced-disabled', 'a live World OceanPatch'));
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0)
      return err(
        this.failure('water-advanced-invalid-input', 'finite nonnegative frame delta seconds'),
      );
    this.#deltaSeconds = deltaSeconds;
    return ok(undefined);
  }
  bindNoiseRevision(revision: number | null): void {
    if (revision === this.#noiseRevision || this.#state.status === 'retired') return;
    this.#noiseRevision = revision;
    this.reset();
  }
  /** A visual child revision never invalidates residual, query, foam or force history. */
  bindVisualNormalDetailNoiseRevision(revision: number | null): void {
    const config = this.recipe.asset.oceanPatchConfig;
    if (
      this.#state.status === 'retired' ||
      this.recipe.asset.configurationVersion !== 2 ||
      !config ||
      !('visualNormalDetailFft' in config) ||
      revision === this.#visualNoiseRevision
    )
      return;
    this.#visualNoiseRevision = revision;
    this.#visualRevision++;
    this.#visualOutputValid = false;
    this.#visualError = undefined;
    this.abandonUnretainedPending();
  }
  unavailableVisualNormalDetailFft(error: WaterAdvancedError): void {
    if (
      this.#state.status === 'retired' ||
      this.recipe.asset.configurationVersion !== 2 ||
      !('visualNormalDetailFft' in this.recipe.asset.oceanPatchConfig)
    )
      return;
    this.#visualOutputValid = false;
    this.#visualError = error;
  }
  /** The opt-in rigid source and its waves share the completed native solver clock. */
  bindNativeSourceTime(
    source: object,
    timeSeconds: number,
    completedStep?: number,
  ): Result<void, WaterAdvancedError> {
    if (this.#state.status === 'retired')
      return err(this.failure('water-advanced-disabled', 'a live World OceanPatch'));
    if (
      this.recipe.asset.oceanPatchConfig.algorithm !== 'mode-projected-gravity/1' ||
      !Number.isFinite(timeSeconds) ||
      timeSeconds < 0 ||
      (completedStep !== undefined && (!Number.isSafeInteger(completedStep) || completedStep < 0))
    )
      return err(
        this.failure(
          'water-advanced-invalid-input',
          'finite nonnegative native source time for mode-projected gravity',
        ),
      );
    if (
      this.#nativeSourceOwner !== undefined &&
      (source !== this.#nativeSourceOwner ||
        timeSeconds < (this.#nativeSourceTimeSeconds ?? 0) ||
        (completedStep !== undefined && completedStep < (this.#nativeSourceStep ?? 0)))
    )
      this.reset();
    this.#nativeSourceOwner = source;
    if (this.#nativeSourceTimeSeconds !== timeSeconds || this.#nativeSourceStep !== completedStep) {
      this.#nativeSourceTimeSeconds = timeSeconds;
      this.#nativeSourceStep = completedStep;
      this.#pending = undefined;
    }
    return ok(undefined);
  }
  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled || this.#state.status === 'retired') return;
    this.#enabled = enabled;
    if (enabled) this.reset();
    else {
      this.#generation++;
      this.#state = { status: 'disabled' };
      this.#visualOutputValid = false;
      this.#visualError = undefined;
      this.clearPending();
    }
  }
  setPaused(paused: boolean): void {
    if (this.#paused === paused || this.#state.status === 'retired') return;
    this.#paused = paused;
    this.#queryLifecycle++;
    this.#queryField = undefined;
    if (!paused) this.#sourceRevision++;
    this.#pending = undefined;
    if (this.#state.status === 'ready' || this.#state.status === 'paused')
      this.#state = { ...this.#state, status: paused ? 'paused' : 'ready' };
    if (paused) this.event('paused', this.recipe.asset.oceanPatchConfig.fftResolution);
  }
  reset(): void {
    if (this.#state.status === 'retired') return;
    this.#generation++;
    this.#timeSeconds = 0;
    this.#reset = true;
    this.#visualOutputValid = false;
    this.#visualError = undefined;
    this.#sourceRevision++;
    this.clearPending();
    this.#state = this.#enabled
      ? {
          status: 'initializing',
          generation: this.#generation,
          allocation: 'initial-1x1',
          requestedSize: this.recipe.asset.oceanPatchConfig.fftResolution,
        }
      : { status: 'disabled' };
    this.event('reset', 1);
  }
  requestStageCapture(): void {
    if (this.#state.status === 'retired') return;
    this.#captureRequest++;
    this.#readbacks = [];
    this.#readbackError = undefined;
    this.#pending = undefined;
  }
  configureQueryFeedback(binding: WaterResidualQueryBinding | undefined): void {
    if (this.#state.status === 'retired') return;
    if (canonicalJson(binding) === canonicalJson(this.#queryBinding)) return;
    this.#queryBinding = binding && Object.freeze({ ...binding });
    this.#queryLifecycle++;
    this.#queryRegion = undefined;
    this.clearQueryRequestAccumulation();
    this.#queryReceivers = [];
    this.#queryField = undefined;
    this.#queryError = undefined;
    this.#pending = undefined;
  }
  invalidateQueryBody(guid: string, generation: number | undefined): void {
    if (this.#queryBinding?.bodyGuid !== guid || this.#queryBinding.bodyGeneration === generation)
      return;
    this.#queryLifecycle++;
    this.#queryField = undefined;
    this.#queryRegion = undefined;
    this.clearQueryRequestAccumulation();
    this.#pending = undefined;
    this.#queryError = residualQueryFailure('body-generation');
  }
  queryLifecycleIdentity(guid: string): string | undefined {
    if (this.#queryBinding?.bodyGuid !== guid) return;
    return canonicalJson([
      this.recipe.guid,
      this.recipe.contentVersion,
      this.#generation,
      this.#sourceRevision,
      this.#queryLifecycle,
      this.#paused,
      this.#enabled,
      this.#queryBinding,
    ]);
  }
  private queryDomain(): WaterResidualQueryDomain | undefined {
    const config = this.recipe.asset.oceanPatchConfig;
    if (config.algorithm !== 'mode-projected-gravity/1') return;
    return {
      resolution: config.fftResolution,
      centerXZ: config.centerXZ,
      domainLengthM: config.domainLengthM,
      baseHeightM: config.baseHeightM,
      yawRadians: 0,
    };
  }
  /**
   * Runtime supplies resolved pontoon positions; the tile contains exact original source cells.
   * Request positions are consumed by value during this call; callers may mutate their arrays after return.
   */
  requestQueryRegion(
    guid: string,
    generation: number,
    positions: readonly Vec3[],
    receiver?: WaterResidualQueryReceiver,
  ): void {
    if (this.#queryBinding?.bodyGuid !== guid || this.#queryBinding.bodyGeneration !== generation)
      return;
    const config = this.recipe.asset.oceanPatchConfig;
    if (config.algorithm !== 'mode-projected-gravity/1' || positions.length === 0) return;
    const n = config.fftResolution,
      size = Math.min(n, 128),
      spacing = config.domainLengthM / n;
    let insideCount = 0;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const position of positions) {
      if (
        !position.every(Number.isFinite) ||
        !(Math.abs(position[0] - config.centerXZ[0]) <= config.domainLengthM / 2) ||
        !(Math.abs(position[2] - config.centerXZ[1]) <= config.domainLengthM / 2)
      )
        continue;
      insideCount += 1;
      minX = Math.min(minX, position[0]);
      maxX = Math.max(maxX, position[0]);
      minZ = Math.min(minZ, position[2]);
      maxZ = Math.max(maxZ, position[2]);
    }
    if (insideCount === 0) return;
    if (
      receiver &&
      !this.#queryReceivers.some(
        (row) => row.entity === receiver.entity && row.generation === receiver.generation,
      )
    ) {
      if (this.#queryReceivers.length >= 32) {
        this.#queryError = residualQueryFailure('receiver-limit');
        return;
      }
      this.#queryReceivers.push(Object.freeze({ ...receiver }));
    }
    if (this.#queryRequestCount + insideCount > 1024) {
      this.#queryError = residualQueryFailure('region-request-limit');
      this.clearQueryRequestAccumulation();
      this.#queryRegion = undefined;
      return;
    }
    this.#queryRequestCount += insideCount;
    if (this.#queryWorldBounds) {
      this.#queryWorldBounds.minX = Math.min(this.#queryWorldBounds.minX, minX);
      this.#queryWorldBounds.maxX = Math.max(this.#queryWorldBounds.maxX, maxX);
      this.#queryWorldBounds.minZ = Math.min(this.#queryWorldBounds.minZ, minZ);
      this.#queryWorldBounds.maxZ = Math.max(this.#queryWorldBounds.maxZ, maxZ);
    } else {
      this.#queryWorldBounds = { minX, maxX, minZ, maxZ };
    }
    const bounds = this.#queryWorldBounds;
    const minXPixel = (bounds.minX - config.centerXZ[0]) / spacing + n / 2 - 0.5;
    const maxXPixel = (bounds.maxX - config.centerXZ[0]) / spacing + n / 2 - 0.5;
    const minZPixel = (bounds.minZ - config.centerXZ[1]) / spacing + n / 2 - 0.5;
    const maxZPixel = (bounds.maxZ - config.centerXZ[1]) / spacing + n / 2 - 0.5;
    const low = [Math.min(minXPixel, maxXPixel), Math.min(minZPixel, maxZPixel)];
    const high = [Math.max(minXPixel, maxXPixel), Math.max(minZPixel, maxZPixel)];
    const padding = Math.ceil(2 / spacing) + 2;
    if (
      low.some(
        (value, axis) => !Number.isFinite(value) || Number(high[axis]) - value + padding * 2 > size,
      )
    ) {
      this.#queryError = residualQueryFailure('region-limit', { maximumCellsPerAxis: size });
      this.clearQueryRequestAccumulation();
      this.#queryRegion = undefined;
      return;
    }
    const wrap = (value: number) => ((value % n) + n) % n;
    this.#queryRegion = {
      offset: [
        wrap(Math.floor((Number(low[0]) + Number(high[0]) - size) / 2)),
        wrap(Math.floor((Number(low[1]) + Number(high[1]) - size) / 2)),
      ],
      size: [size, size],
    };
    if (
      this.#queryError?.detail.reason === 'region-limit' ||
      this.#queryError?.detail.reason === 'region-request-limit'
    )
      this.#queryError = undefined;
  }
  /** Runtime's current enabled native participants own receiver lifetime, independently of render cadence. */
  retainQueryReceivers(receivers: readonly WaterResidualQueryReceiver[]): void {
    this.#queryReceivers = this.#queryReceivers.filter((row) =>
      receivers.some(
        (receiver) => receiver.entity === row.entity && receiver.generation === row.generation,
      ),
    );
  }
  applyQueryResidual(
    result: WaterQueryResult,
    input: WaterQueryInput,
  ): Result<WaterQueryResult, WaterError> {
    if (result.bodyGuid !== this.#queryBinding?.bodyGuid) return ok(result);
    const domain = this.queryDomain();
    if (domain === undefined) return ok(result);
    return composeWaterQueryResidual(
      result,
      input,
      this.#queryBinding
        ? {
            binding: this.#queryBinding,
            domain,
            ...(['ready', 'paused', 'stale'].includes(this.#state.status) && this.#queryField
              ? { field: this.#queryField }
              : {}),
          }
        : undefined,
    );
  }
  /** One detached bounded field per worker task, shared by its pontoon queries. */
  queryFeedbackSnapshot(guid: string): WaterResidualQuerySource | undefined {
    if (this.#queryBinding?.bodyGuid !== guid) return;
    const domain = this.queryDomain();
    if (domain === undefined) return;
    return {
      binding: this.#queryBinding,
      domain,
      ...(['ready', 'paused', 'stale'].includes(this.#state.status) && this.#queryField
        ? {
            field: { ...this.#queryField, heightsM: Array.from(this.#queryField.heightsM) },
          }
        : {}),
    };
  }
  acceptQueryReadback(
    frame: WaterOceanPatchFrame,
    readback:
      | Readonly<{
          width: number;
          height: number;
          bytesPerRow: number;
          bytes: Uint8Array;
          completion: WaterAdvancedCompletion;
        }>
      | undefined,
  ): Result<void, WaterError> {
    const issued = this.#issued.get(frame),
      query = frame.queryFeedback;
    if (!this.#queryReservations.has(frame)) return err(residualQueryFailure('unissued-readback'));
    this.#queryReservations.delete(frame);
    this.#queryInFlight.delete(frame.sequence);
    if (!issued) return err(residualQueryFailure('retired-readback'));
    if (
      !query ||
      !issued?.completion ||
      frame.generation !== this.#generation ||
      query.lifecycleRevision !== this.#queryLifecycle ||
      canonicalJson(query.binding) !== canonicalJson(this.#queryBinding)
    )
      return err(residualQueryFailure('retired-readback'));
    const admitsReadbackLayout = (): boolean =>
      !(
        frame.nativeSourceStep === undefined ||
        frame.nativeSourceTimeSeconds === undefined ||
        !readback ||
        readback.width !== query.size[0] ||
        readback.height !== query.size[1] * (1 + (query.receivers?.length ?? 0)) ||
        readback.bytesPerRow < readback.width * 4 ||
        readback.bytes.byteLength < readback.height * readback.bytesPerRow ||
        canonicalJson(readback.completion) !== canonicalJson(issued.completion)
      );
    if (
      !admitsReadbackLayout() ||
      !readback ||
      frame.nativeSourceStep === undefined ||
      frame.nativeSourceTimeSeconds === undefined
    ) {
      this.#queryError = residualQueryFailure('readback-unavailable');
      return err(this.#queryError);
    }
    if (this.#queryField && frame.sequence <= this.#queryField.sourceSequence) return ok(undefined);
    const heights = new Float32Array(readback.width * readback.height);
    const bytes = new DataView(
      readback.bytes.buffer,
      readback.bytes.byteOffset,
      readback.bytes.byteLength,
    );
    for (let z = 0; z < readback.height; z++)
      for (let x = 0; x < readback.width; x++)
        heights[z * readback.width + x] = bytes.getFloat32(z * readback.bytesPerRow + x * 4, true);
    if (!heights.every(Number.isFinite)) {
      this.#queryError = residualQueryFailure('nonfinite-readback');
      return err(this.#queryError);
    }
    const config = this.recipe.asset.oceanPatchConfig;
    if (config.algorithm !== 'mode-projected-gravity/1')
      return err(residualQueryFailure('retired-readback'));
    this.#queryField = Object.freeze({
      offset: query.offset,
      size: query.size,
      binding: query.binding,
      recipeGuid: this.recipe.guid,
      recipeVersion: this.recipe.contentVersion,
      patchGeneration: frame.generation,
      deviceGeneration: readback.completion.deviceGeneration,
      sourceSequence: frame.sequence,
      sourcePhysicsStep: frame.nativeSourceStep,
      timeSeconds: frame.nativeSourceTimeSeconds,
      simulationTimeSeconds: frame.timeSeconds,
      completedFrame: readback.completion.frameId,
      resolution: config.fftResolution,
      centerXZ: config.centerXZ,
      domainLengthM: config.domainLengthM,
      baseHeightM: config.baseHeightM,
      yawRadians: 0,
      heightsM: heights,
      ...(query.receivers === undefined ? {} : { receivers: query.receivers }),
    });
    this.#queryCompleted++;
    this.#queryBytes += readback.bytes.byteLength;
    this.#queryError = undefined;
    return ok(undefined);
  }
  unavailableReadbacks(
    frame: WaterOceanPatchFrame,
    cause?: unknown,
  ): Result<void, WaterAdvancedError> {
    const issued = this.#issued.get(frame);
    if (
      frame.generation !== this.#generation ||
      !issued?.submitted ||
      !issued.captureStages ||
      frame.captureRequest !== this.#captureRequest
    )
      return ok(undefined);
    delete issued.completion;
    const error = this.failure(
      'water-advanced-readback-unavailable',
      'completed feature-texture observations delivered to the World owner',
      cause,
    );
    this.#readbackError = error;
    return err(error);
  }
  frame(): WaterOceanPatchFrame | undefined {
    if (
      !this.#enabled ||
      this.#deltaSeconds === undefined ||
      ['retired', 'unavailable', 'unsupported'].includes(this.#state.status)
    )
      return undefined;
    const native = this.recipe.asset.oceanPatchConfig.algorithm === 'mode-projected-gravity/1';
    if (native && this.#nativeSourceTimeSeconds === undefined) return undefined;
    const deltaSeconds = this.#deltaSeconds;
    const issuing = !this.#pending;
    if (issuing && this.#queryBinding && this.#queryRegion && this.#queryInFlight.size >= 3)
      this.#querySkipped++;
    const createPendingFrame = (): WaterOceanPatchFrame => {
      return Object.freeze({
        recipe: this.recipe,
        generation: this.#generation,
        sequence: ++this.#sequence,
        timeSeconds:
          native && !this.#paused
            ? (this.#nativeSourceTimeSeconds ?? this.#timeSeconds)
            : this.#timeSeconds + (this.#paused || this.#reset ? 0 : deltaSeconds),
        paused: this.#paused,
        reset: this.#reset,
        reseedSource: this.#sourceRevision !== this.#submittedSourceRevision,
        sourceRevision: this.#sourceRevision,
        noiseRevision: this.#noiseRevision,
        ...(this.recipe.asset.configurationVersion === 2
          ? {
              visualNormalDetailFft: Object.freeze({
                revision: this.#visualRevision,
                noiseRevision: this.#visualNoiseRevision,
                reset: !this.#visualOutputValid,
              }),
            }
          : {}),
        queryReceivers: Object.freeze([...this.#queryReceivers]),
        ...(this.#nativeSourceStep === undefined
          ? {}
          : { nativeSourceStep: this.#nativeSourceStep }),
        ...(this.#nativeSourceTimeSeconds === undefined
          ? {}
          : { nativeSourceTimeSeconds: this.#nativeSourceTimeSeconds }),
        captureStages: this.#captureRequest !== this.#submittedCaptureRequest,
        captureRequest:
          this.#captureRequest !== this.#submittedCaptureRequest ? this.#captureRequest : null,
        ...(this.#queryBinding &&
        this.#nativeSourceStep !== undefined &&
        this.#queryRegion &&
        this.#queryInFlight.size < 3
          ? {
              queryFeedback: {
                ...this.#queryRegion,
                binding: this.#queryBinding,
                lifecycleRevision: this.#queryLifecycle,
                receivers: Object.freeze([...this.#queryReceivers]),
              },
            }
          : {}),
      });
    };
    this.#pending ??= createPendingFrame();
    if (!this.#issued.has(this.#pending))
      this.#issued.set(this.#pending, {
        submitted: false,
        captureStages: false,
        reset: this.#pending.reset,
        references: 0,
      });
    if (this.#pending.queryFeedback && !this.#queryReservations.has(this.#pending)) {
      this.#queryInFlight.add(this.#pending.sequence);
      this.#queryReservations.set(this.#pending, { submitted: false });
    }
    if (issuing) this.clearQueryRequestAccumulation();
    return this.#pending;
  }
  submitted(
    frame: WaterOceanPatchFrame,
    applied: Readonly<{
      reset: boolean;
      captureStages: boolean;
    }> = frame,
  ): Result<void, WaterAdvancedError> {
    const issued = this.#issued.get(frame);
    if (
      frame.generation !== this.#generation ||
      !issued ||
      issued.submitted ||
      frame.sequence <= this.#submittedSequence ||
      (applied.captureStages && !frame.captureStages)
    )
      return err(
        this.failure(
          'water-advanced-stale-generation',
          'an issued unacknowledged World OceanPatch frame in submission order',
        ),
      );
    this.#submittedSequence = frame.sequence;
    this.#timeSeconds = frame.timeSeconds;
    this.#reset = false;
    this.#submittedSourceRevision = frame.sourceRevision;
    if (applied.captureStages && frame.captureRequest !== null)
      this.#submittedCaptureRequest = frame.captureRequest;
    issued.submitted = true;
    const reservation = this.#queryReservations.get(frame);
    if (reservation) reservation.submitted = true;
    issued.captureStages = applied.captureStages;
    issued.reset = applied.reset;
    if (this.#pending === frame) this.#pending = undefined;
    return ok(undefined);
  }
  visualNormalDetailFftSubmitted(
    frame: WaterOceanPatchFrame,
    size: number,
    deviceGeneration: number,
  ): Result<void, WaterAdvancedError> {
    const issued = this.#issued.get(frame);
    const config = frame.recipe.asset.oceanPatchConfig;
    const visual = frame.visualNormalDetailFft;
    if (
      !issued?.submitted ||
      frame.generation !== this.#generation ||
      !visual ||
      visual.revision !== this.#visualRevision ||
      visual.noiseRevision !== this.#visualNoiseRevision ||
      frame.recipe.asset.configurationVersion !== 2 ||
      config.algorithm !== 'mode-projected-gravity/1' ||
      !('visualNormalDetailFft' in config) ||
      size !== config.visualNormalDetailFft.fftResolution ||
      !Number.isSafeInteger(deviceGeneration) ||
      deviceGeneration < 0
    )
      return err(
        this.failure(
          'water-advanced-stale-generation',
          'the current visual FFT child revision, exact target size and submitted device generation',
        ),
      );
    issued.visualNormalDetailFft = Object.freeze({
      revision: visual.revision,
      size,
      deviceGeneration,
    });
    return ok(undefined);
  }
  retain(frame: WaterOceanPatchFrame): void {
    const issued = this.#issued.get(frame);
    if (issued) issued.references++;
  }
  submittedQueryReadback(frame: WaterOceanPatchFrame): void {
    const reservation = this.#queryReservations.get(frame);
    if (reservation) reservation.submitted = true;
  }
  discarded(frame: WaterOceanPatchFrame): void {
    const issued = this.#issued.get(frame);
    if (issued && --issued.references > 0) return;
    // Submitted observations can outlive their extracted source-frame references.
    if (!issued?.submitted) this.#issued.delete(frame);
    if (this.#queryReservations.get(frame)?.submitted === false) {
      this.#queryReservations.delete(frame);
      this.#queryInFlight.delete(frame.sequence);
    }
    if (this.#pending === frame) this.#pending = undefined;
  }
  allocated(size: number, deviceGeneration: number): void {
    if (this.#state.status === 'retired') return;
    if (size === 1) {
      this.event('created-1x1', 1, deviceGeneration);
      this.#state = {
        status: 'initializing',
        generation: this.#generation,
        allocation: 'resolution-requested',
        requestedSize: this.recipe.asset.oceanPatchConfig.fftResolution,
      };
    } else {
      this.event('requested-resolution', size, deviceGeneration);
      this.#state = { status: 'stale', generation: this.#generation, size, deviceGeneration };
    }
  }
  completed(
    frame: WaterOceanPatchFrame,
    completion: WaterAdvancedCompletion,
    size: number,
    allocation: boolean,
  ): Result<void, WaterAdvancedError> {
    const issued = this.#issued.get(frame);
    if (
      frame.generation !== this.#generation ||
      !issued?.submitted ||
      ![completion.frameId, completion.deviceGeneration, completion.graphGeneration].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      return err(
        this.failure(
          'water-advanced-stale-generation',
          'a submitted World OceanPatch completion in its current device generation',
        ),
      );
    if (
      (issued.captureStages && frame.captureRequest === this.#captureRequest) ||
      frame.queryFeedback
    )
      issued.completion = Object.freeze({ ...completion });
    if (frame.sequence <= this.#completedSequence) return ok(undefined);
    this.#completedSequence = frame.sequence;
    this.#completion = Object.freeze({ ...completion });
    const acceptVisualNormalCompletion = (): void => {
      const visualSubmission = issued.visualNormalDetailFft;
      const visual = frame.visualNormalDetailFft;
      const visualConfig =
        frame.recipe.asset.configurationVersion === 2 &&
        frame.recipe.asset.oceanPatchConfig.algorithm === 'mode-projected-gravity/1' &&
        'visualNormalDetailFft' in frame.recipe.asset.oceanPatchConfig
          ? frame.recipe.asset.oceanPatchConfig.visualNormalDetailFft
          : undefined;
      if (
        visualSubmission &&
        visualConfig &&
        visual &&
        visualSubmission.revision === this.#visualRevision &&
        visual.revision === this.#visualRevision &&
        visual.noiseRevision === this.#visualNoiseRevision &&
        visualSubmission.size === visualConfig.fftResolution &&
        visualSubmission.deviceGeneration === completion.deviceGeneration
      ) {
        this.#visualOutputValid = true;
        this.#visualOutput = Object.freeze({
          generation: frame.generation,
          revision: visual.revision,
          noiseRevision: visual.noiseRevision,
          size: visualSubmission.size,
          completion: Object.freeze({ ...completion }),
        });
      }
    };
    acceptVisualNormalCompletion();
    if (!allocation && !issued.reset && size > 1) {
      const first = this.#state.status !== 'ready' && this.#state.status !== 'paused';
      this.#state = {
        status: this.#paused ? 'paused' : 'ready',
        generation: this.#generation,
        size,
        deviceGeneration: completion.deviceGeneration,
        completedFrame: completion.frameId,
      };
      if (first) this.event('ready', size, completion.deviceGeneration);
    }
    return ok(undefined);
  }
  acceptReadbacks(
    frame: WaterOceanPatchFrame,
    readbacks: readonly WaterAdvancedTextureReadback[],
  ): Result<void, WaterAdvancedError> {
    const issued = this.#issued.get(frame);
    if (frame.generation !== this.#generation || !issued?.submitted)
      return err(
        this.failure(
          'water-advanced-stale-generation',
          'readbacks for an issued submitted World OceanPatch frame',
        ),
      );
    if (!issued?.captureStages || frame.captureRequest !== this.#captureRequest)
      return ok(undefined);
    const completion = issued.completion;
    if (
      frame.generation !== this.#generation ||
      !completion ||
      readbacks.some(
        (row) =>
          row.completion.frameId !== completion.frameId ||
          row.completion.deviceGeneration !== completion.deviceGeneration ||
          row.completion.graphGeneration !== completion.graphGeneration,
      )
    )
      return err(
        this.failure(
          'water-advanced-stale-generation',
          'readbacks paired with the exact World OceanPatch completion',
        ),
      );
    delete issued.completion;
    if (readbacks.length === 0)
      return this.unavailableReadbacks(frame, { reason: 'no-feature-texture-observations' });
    this.#readbackError = undefined;
    this.#readbacks = structuredClone(
      readbacks.map((row) => ({
        ...row,
        sourceFrame: {
          generation: frame.generation,
          sequence: frame.sequence,
          timeSeconds: frame.timeSeconds,
          ...(frame.nativeSourceStep === undefined
            ? {}
            : { nativeSourceStep: frame.nativeSourceStep }),
        },
      })),
    );
    return ok(undefined);
  }
  textureReadbacks(): readonly WaterOceanPatchTextureReadback[] {
    return structuredClone(this.#readbacks);
  }
  fail(error: WaterAdvancedError): void {
    if (this.#state.status === 'retired') return;
    this.#visualOutputValid = false;
    this.#queryLifecycle++;
    this.#state = {
      status: error.code === 'water-advanced-unsupported' ? 'unsupported' : 'unavailable',
      generation: this.#generation,
      error,
    };
    this.#pending = undefined;
    this.#issued = new WeakMap();
    this.#queryField = undefined;
  }
  deviceLost(): void {
    this.reset();
  }
  retire(): void {
    if (this.#state.status === 'retired') return;
    this.#generation++;
    this.#enabled = false;
    this.#visualOutputValid = false;
    this.clearPending();
    this.#queryBinding = undefined;
    this.#queryRegion = undefined;
    this.clearQueryRequestAccumulation();
    this.#queryReceivers = [];
    this.#queryError = undefined;
    this.#nativeSourceOwner = undefined;
    this.#nativeSourceTimeSeconds = undefined;
    this.#nativeSourceStep = undefined;
    this.#state = { status: 'retired' };
    this.event('retired', 0);
  }
  /** @internal Lightweight current facts for exact profiler pass-name admission. */
  _queryProfileState(): WaterOceanPatchQueryProfileState {
    const config = this.recipe.asset.oceanPatchConfig;
    const size =
      this.#state.status === 'ready' ||
      this.#state.status === 'paused' ||
      this.#state.status === 'stale'
        ? this.#state.size
        : this.#state.status === 'initializing'
          ? this.#state.allocation === 'initial-1x1'
            ? 1
            : this.#state.requestedSize
          : 0;
    return Object.freeze({
      recipeGuid: this.recipe.guid,
      recipeVersion: this.recipe.contentVersion,
      generation: this.#generation,
      algorithm: config.algorithm,
      resolution: config.fftResolution,
      size,
      enabled: this.#enabled,
      ...(this.#queryBinding ? { binding: this.#queryBinding } : {}),
      receivers: Object.freeze(
        this.#queryReceivers.map((receiver) => Object.freeze({ ...receiver })),
      ),
    });
  }
  inspect(): WaterOceanPatchInspection {
    const accepted =
      this.#queryField && (({ heightsM: _heights, ...metadata }) => metadata)(this.#queryField);
    return Object.freeze({
      recipeGuid: this.recipe.guid,
      recipeVersion: this.recipe.contentVersion,
      generation: this.#generation,
      state: this.#state,
      timeSeconds: this.#timeSeconds,
      noiseRevision: this.#noiseRevision,
      ...(this.recipe.asset.configurationVersion === 2
        ? {
            visualNormalDetailFft: Object.freeze({
              revision: this.#visualRevision,
              noiseRevision: this.#visualNoiseRevision,
              valid: this.#visualOutputValid,
              ...(this.#visualError === undefined ? {} : { error: this.#visualError }),
              ...(this.#visualOutput === undefined ? {} : { output: this.#visualOutput }),
            }),
          }
        : {}),
      submittedSequence: this.#submittedSequence,
      completedSequence: this.#completedSequence,
      events: Object.freeze([...this.#events]),
      ...(this.#completion ? { completion: this.#completion } : {}),
      ...(this.#readbackError ? { readbackError: this.#readbackError } : {}),
      queryFeedback: {
        ...(this.#queryBinding ? { binding: this.#queryBinding } : {}),
        inFlight: this.#queryInFlight.size,
        maximumInFlight: 3 as const,
        maximumBytesPerFrame:
          Math.min(this.recipe.asset.oceanPatchConfig.fftResolution, 128) ** 2 *
          4 *
          (1 + this.#queryReceivers.length),
        skipped: this.#querySkipped,
        completed: this.#queryCompleted,
        bytesReceived: this.#queryBytes,
        ...(this.#queryError ? { error: this.#queryError } : {}),
        ...(accepted ? { accepted } : {}),
      },
    });
  }
  private clearQueryRequestAccumulation(): void {
    this.#queryRequestCount = 0;
    this.#queryWorldBounds = undefined;
  }
  private clearPending(): void {
    this.#queryLifecycle++;
    this.#pending = undefined;
    this.#submittedCaptureRequest = this.#captureRequest;
    this.#issued = new WeakMap();
    this.#readbacks = [];
    this.#completion = undefined;
    this.#readbackError = undefined;
    this.#queryField = undefined;
  }
  private abandonUnretainedPending(): void {
    const frame = this.#pending;
    if (!frame) return;
    const issued = this.#issued.get(frame);
    if (issued && !issued.submitted && issued.references === 0) {
      this.#issued.delete(frame);
      const reservation = this.#queryReservations.get(frame);
      if (reservation && !reservation.submitted) {
        this.#queryReservations.delete(frame);
        this.#queryInFlight.delete(frame.sequence);
      }
    }
    this.#pending = undefined;
  }
  private event(
    event: WaterOceanPatchInspection['events'][number]['event'],
    size: number,
    deviceGeneration?: number,
  ): void {
    this.#events.push(
      Object.freeze({
        event,
        generation: this.#generation,
        size,
        ...(deviceGeneration === undefined ? {} : { deviceGeneration }),
      }),
    );
    if (this.#events.length > 64) this.#events.shift();
  }
}
