import type { AssetChange } from '@forgeax/engine-assets-runtime/internal';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import {
  type BindGroup,
  type Buffer,
  type RhiCommandEncoder,
  RhiError,
  type RhiRenderPassEncoder,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RendererGenerationFence } from '../assembly/renderer-frame-transaction';
import { ResidencyLifetime } from '../device/residency-lifetime';
import type { SceneContentCursor } from '../gpu-scene-content-boxes';
import type { StandardIrradianceFieldGi } from '../pipeline/standard-profile';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import type { LightSnapshot } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import { recordContext } from '../world/view-record-context';
import type { CardAtlasCapture, CardCaptureSlice } from './card-capture-schedule';
import {
  allocateCardRadiosity,
  type CardRadiosityPlan,
  CardRadiositySchedule,
  type CardRadiosityUpdate,
  packCardRadiosityFrame,
  planCardRadiosity,
} from './card-radiosity';
import { CardResidency, type CardResidencyInspection } from './card-residency';
import { createRayDiffuseComposite } from './diffuse-composite';
import {
  adoptFieldEdit,
  diffFieldEdit,
  type FieldEdit,
  fieldEditState,
  fieldOutsideEmpty,
} from './field-edit';
import {
  deriveFieldReceivers,
  type FieldReceiverFrame,
  unavailableFieldReceivers,
} from './field-receiver';
import { globalSdfEditBox, packGlobalSdfEditBox } from './global-sdf';
import { createGlobalSdfTexture, GLOBAL_SDF_TEXTURE_WGSL } from './global-sdf-texture';
import {
  createIrradianceFieldKernel,
  createIrradianceFieldViewKernels,
  IRRADIANCE_FIELD_FAR_RADIANCE,
  IRRADIANCE_FIELD_FRAME_BYTES,
  IRRADIANCE_FIELD_LIGHTS_BYTES,
  IRRADIANCE_FIELD_ORIGIN_BYTES,
  IRRADIANCE_FIELD_OUTSIDE_EMPTY,
  IRRADIANCE_FIELD_RAY_BYTES,
  IRRADIANCE_FIELD_REFLECTION_HISTORY_BYTES,
  IRRADIANCE_FIELD_REFLECTION_RAY_BYTES,
  IRRADIANCE_FIELD_SURFACE_BYTES,
  IRRADIANCE_FIELD_UNIFORM_BYTES,
  type IrradianceFieldKernelStage,
  irradianceFieldDepthClamp,
  irradianceFieldKernelWgsl,
  packIrradianceFieldFrame,
  packIrradianceFieldUniform,
} from './irradiance-field';
import { adoptFieldSourceEpoch, writeFieldEdit } from './irradiance-field-edit';
import type { FieldGatherExtent } from './irradiance-field-graph';
import {
  IRRADIANCE_FIELD_DEPTH_BYTES,
  IRRADIANCE_FIELD_META_BYTES,
  IRRADIANCE_FIELD_META_ENCODING,
  IRRADIANCE_FIELD_PROBE_BYTES,
  IRRADIANCE_FIELD_RELIGHT_SWEEPS,
  type IrradianceFieldPlan,
  irradianceFieldRadiosityPeriod,
  irradianceFieldRelightHysteresis,
  planIrradianceField,
} from './irradiance-field-plan';
import { onlyPrimaryDirectionalColorChanged, packLights } from './path-input';
import {
  type ProbeClipmapInspection,
  ProbeClipmapScheduler,
  type ProbeFrameSchedule,
} from './probe-clipmap';
import { requirePublishedKernel } from './published-kernel';
import { createRayReflectionComposite } from './reflections-composite';
import type { ProbeCardCapture } from './renderer-probe-cards';
import { type ProbeGlobalRegion, prepareProbeGlobalRegion } from './renderer-probe-global';
import {
  type PreparedWorldAcceleration,
  prepareWorldAcceleration,
  selectWorldTraversal,
  WORLD_ACCELERATION_TRIANGLE_HEADROOM,
  WorldAccelerationGeometryIds,
  type WorldAccelerationInspection,
  type WorldTraversalFallback,
  worldAccelerationEdit,
  worldAccelerationRoster,
} from './renderer-world-acceleration';
import { SceneFieldRows, sceneFieldSourceEpoch } from './scene-field-projection';
import {
  createSdfSceneTextureProjection,
  SDF_SCENE_TEXTURE_PROJECT_WGSL,
} from './sdf-scene-texture';
import type { VisibleSurfaceProjection } from './visible-surface';
import type { WorldTraversal } from './world-traversal';

type Kernel = Extract<
  Awaited<ReturnType<typeof createIrradianceFieldKernel>>,
  { ok: true }
>['value'];
type ViewFactory = Extract<
  Awaited<ReturnType<typeof createIrradianceFieldViewKernels>>,
  { ok: true }
>['value'];
type ViewKernels = ViewFactory['kernels'];
type FieldKernelStage = Exclude<IrradianceFieldKernelStage, 'traceReflections'>;
interface FieldReflectionBundle {
  readonly trace: Kernel;
  readonly view: Extract<
    Awaited<ReturnType<ViewFactory['reflectionKernels']>>,
    { ok: true }
  >['value'];
  readonly composite: Extract<
    Awaited<ReturnType<typeof createRayReflectionComposite>>,
    { ok: true }
  >['value'];
}
type FieldReflectionPreparation =
  | { readonly state: 'unrequested' | 'preparing' }
  | { readonly state: 'ready'; readonly value: FieldReflectionBundle }
  | { readonly state: 'failed'; readonly cause: RhiError };

type FieldGatherPreparation =
  | { readonly state: 'unrequested' | 'preparing' | 'ready' }
  | { readonly state: 'failed'; readonly cause: RhiError };

function fieldPreparationError(cause: unknown): RhiError {
  return cause instanceof RhiError
    ? cause
    : new RhiError({
        code: 'rhi-not-available',
        expected:
          'a complete current Global SDF region, cooked Card layouts and admitted analytic lights for irradiance-field GI',
        hint: 'inspect the irradiance-field preparation cause and repair its producer before retrying the changed scene',
        detail: {
          error: {
            code: 'irradiance-field-preparation',
            message: cause instanceof Error ? cause.message : JSON.stringify(cause),
            ...(typeof cause === 'object' && cause !== null ? { detail: cause } : {}),
          },
        },
      });
}

async function prepareFieldKernels(
  device: RenderSystemInternals['device'],
  stages: readonly FieldKernelStage[],
  modules: readonly ShaderModule[],
  traversal: WorldTraversal,
): Promise<Record<FieldKernelStage, Kernel>> {
  const kernels = {} as Record<FieldKernelStage, Kernel>;
  // The PSOs are independent. Drain every request before publication or cleanup,
  // then retain stage order when selecting a failure.
  const prepared = await Promise.allSettled(
    stages.map(async (stage, index) => {
      const module = modules[index];
      if (module === undefined) throw new Error(`missing ${stage} module`);
      return [
        stage,
        (await createIrradianceFieldKernel(device, stage, module, traversal)).unwrap(),
      ] as const;
    }),
  );
  for (const result of prepared) {
    if (result.status === 'rejected') throw result.reason;
    const [stage, kernel] = result.value;
    kernels[stage] = kernel;
  }
  return kernels;
}

async function buildFieldReflections(
  runtime: RenderSystemInternals,
  traversal: WorldTraversal,
  source: string,
  base: {
    readonly source: string;
    readonly module: ShaderModule;
    readonly factory: ViewFactory;
    readonly composite: PreparedIrradianceField['composite'];
  },
  current: () => boolean,
): Promise<FieldReflectionBundle | undefined> {
  if (!current()) return undefined;
  const compile = runtime.createShaderModule;
  const registry = runtime.shaderRegistry;
  if (compile === undefined || registry === undefined)
    throw new Error('irradiance field reflections require the current shader publication');
  // Publication can arrive after the diffuse field: never retain the initial entry snapshot.
  const entries = [...registry.entries()];
  const viewSource = requirePublishedKernel(
    entries,
    'generateFieldReflections',
    'standard-gbuffer/2',
  );
  const compositeSource = requirePublishedKernel(
    entries,
    'fs_ray_reflection_field',
    'standard-gbuffer/2',
  );
  const device = runtime.device;
  const modules = await Promise.all([
    compile(device, { label: 'irradiance-field.traceReflections', code: source }).then((r) =>
      r.unwrap(),
    ),
    viewSource === base.source
      ? base.module
      : compile(device, { label: 'irradiance-field.reflection-view', code: viewSource }).then((r) =>
          r.unwrap(),
        ),
    compile(device, {
      label: 'irradiance-field.reflection-composite',
      code: compositeSource,
    }).then((r) => r.unwrap()),
  ]);
  if (!current()) return undefined;
  const [traceModule, viewModule, compositeModule] = modules;
  const trace = (
    await createIrradianceFieldKernel(device, 'traceReflections', traceModule, traversal)
  ).unwrap();
  if (!current()) return undefined;
  const view = (await base.factory.reflectionKernels(viewModule)).unwrap();
  if (!current()) return undefined;
  const composite = (await createRayReflectionComposite(device, compositeModule, 'field')).unwrap();
  return current() ? { trace, view, composite } : undefined;
}

interface IrradianceFieldFrameInput {
  readonly runtime: RenderSystemInternals;
  readonly scene: PersistentGpuDrivenState;
  readonly sourceScope: RenderResourceScope;
  readonly lease: RenderReadLease | undefined;
  readonly lights: readonly LightSnapshot[];
  readonly profile: StandardIrradianceFieldGi;
  /** View extent for the per-pixel gather and Lite reflections. */
  readonly width: number;
  readonly height: number;
  /** False when another lane (Screen Probes) owns the diffuse view gather. */
  readonly gatherView: boolean;
  /** Hardware Screen Probe gather also consumes a separate far-radiance field. */
  readonly farRadiance?: boolean;
  /** Same-frame projection of the optional raster identity attachment. */
  readonly visibleSurface?: VisibleSurfaceProjection | undefined;
  /** World point the probe clipmap levels follow (the view camera). */
  readonly focus: readonly [number, number, number];
}

export interface IrradianceFieldInspection {
  readonly gather: 'irradiance-field';
  readonly state: 'preparing' | 'ready' | 'failed';
  readonly generation: number;
  readonly submittedFrames: number;
  readonly pixelCount: number;
  readonly probes?: {
    readonly dimensions: readonly [number, number, number];
    readonly count: number;
    readonly perFrame: number;
    readonly raysPerProbe: number;
    /** Clipmap windows, traced boxes and scroll work (one level for a fixed field). */
    readonly clipmap: ProbeClipmapInspection;
  };
  /**
   * `captured` reaches `tiles` after ceil(tiles / perFrame) submitted frames.
   * `relit` / `radiated` are the last submitted frame's direct-lit and radiated
   * tiles: static lights and scene relight nothing and radiate `perFrame` tiles.
   */
  readonly cards?: {
    readonly tiles: number;
    readonly captured: number;
    readonly perFrame: number;
    readonly relit: number;
    readonly radiated: number;
  };
  /** Card residency of an editable field: present when the scene exceeds its Card ceilings. */
  readonly residency?: CardResidencyInspection;
  /**
   * This frame's share of the per-frame budgets when CameraViews split them:
   * probe updates, Card capture tiles and Card relight tiles.
   */
  readonly share?: {
    readonly views: number;
    readonly probes: number;
    readonly captureTiles: number;
    readonly relightTiles: number;
  };
  /**
   * The world traversal the field's traces compile against, selected
   * by policy: `'global-sdf'` when hardwareRayTracing is false; otherwise
   * `'ray-query'` when `caps.rayQuery` is supported and the
   * projected scene fits its limits, else `'global-sdf'` with the closed reason.
   */
  readonly traversal?: WorldTraversal;
  readonly traversalFallback?: WorldTraversalFallback;
  /** The `'ray-query'` lane's TLAS residency. */
  readonly acceleration?: WorldAccelerationInspection;
  /** In-place scene edits applied to this generation (moves/removals of field sources). */
  readonly edits?: IrradianceFieldEditStats;
  /**
   * Analytic RectAreaLights the field leaves out of its probe and Card lighting.
   * They still light surfaces directly; only their bounced diffuse is absent.
   */
  readonly excludedAreaLights?: number;
  readonly error?: Pick<RhiError, 'code' | 'expected' | 'hint' | 'detail'>;
}

/** Cumulative in-place edit work of one field generation. */
interface IrradianceFieldEditStats {
  readonly applied: number;
  readonly movedInstances: number;
  readonly removedInstances: number;
  /** Instances installed into headroom rows and atlas tiles without a rebuild. */
  readonly addedInstances: number;
  /** Instances whose material draws were replaced in place (no SDF recompose). */
  readonly rematerializedInstances: number;
  /** Card tiles queued for capture by edits; only the edited instances' tiles. */
  readonly recapturedTiles: number;
  /** Tiles still waiting for recapture. */
  readonly pendingTiles: number;
  /** Global SDF voxels recomposed by the last edit (the whole grid when it fell back). */
  readonly composedVoxels: number;
  /** Probes near the edits (all clipmap levels), updated with fast hysteresis. */
  readonly priorityProbes: number;
  /** Priority probe updates still scheduled. */
  readonly pendingPriorityUpdates: number;
  /** Content changes accepted without re-projecting the scene: no field input changed. */
  readonly skippedProjections: number;
  readonly projectedSources: number;
  readonly materialRootUpdates: number;
  readonly materialDrawVisits: number;
  readonly materialUniformUploads: number;
  readonly assetRootUpdates: number;
  readonly materialBindingRefreshes: number;
}

/** Per-extent view buffers; replaced on resize and retired only after their submissions. */
export interface IrradianceFieldExtent extends FieldGatherExtent {
  /** Lite reflection ray records, raw radiance signal and its denoiser, present
   * when the profile admits them. Fresh history is zero, which every pixel rejects. */
  readonly reflection:
    | {
        readonly rays: Buffer;
        readonly signal: Buffer;
        readonly denoised: Buffer;
        /** `previous` is the last committed frame; a commit swaps the pair. */
        readonly history: () => { readonly previous: Buffer; readonly current: Buffer };
      }
    | undefined;
  readonly lifetime: ResidencyLifetime;
}

/** Persistent per-generation field; the ordinary graph supplies this frame's G-buffer/View. */
export interface PreparedIrradianceField {
  readonly generation: number;
  readonly fence: RendererGenerationFence;
  readonly plan: IrradianceFieldPlan;
  /** Private Card-space history, owned and retired with this field generation.
   * Probe availability is separate from CPU page submission authority. */
  readonly cardRadiosity:
    | {
        readonly plan: CardRadiosityPlan;
        readonly buffers: ReturnType<
          typeof allocateCardRadiosity<{ readonly buffer: Buffer; readonly size: number }>
        >;
        readonly schedule: CardRadiositySchedule;
        update(): CardRadiosityUpdate;
      }
    | undefined;
  readonly region: ProbeGlobalRegion;
  /** Geometry identity only; contact/error qualification is explicitly unavailable. */
  readonly receivers: Result<FieldReceiverFrame, RhiError>;
  readonly cards: ProbeCardCapture;
  /** The one probe scheduler: exposed clipmap slabs, edit sweeps, level rotation. */
  readonly clipmap: ProbeClipmapScheduler;
  readonly tileCount: number;
  readonly half: boolean;
  readonly traversal: WorldTraversal;
  readonly traversalFallback: WorldTraversalFallback | undefined;
  /** Present exactly when `traversal === 'ray-query'`. */
  readonly acceleration: PreparedWorldAcceleration | undefined;
  readonly buffers: Readonly<
    Record<
      | 'field'
      | 'frame'
      | 'lights'
      | 'irradiance'
      | 'moments'
      | 'meta'
      | 'probeList'
      | 'probeOrigins'
      | 'probeRays'
      | 'surfaces'
      | 'cardDirect'
      | 'cardLit',
      { readonly buffer: Buffer; readonly size: number }
    >
  >;
  readonly kernels: Readonly<Record<FieldKernelStage, Kernel>>;
  readonly view: ViewKernels;
  readonly sample: BindGroup;
  /** Independently traced radiance history; placement and scheduling share the clipmap. */
  readonly farRadiance?: {
    readonly buffers: Readonly<
      Record<
        'field' | 'irradiance' | 'moments' | 'meta',
        { readonly buffer: Buffer; readonly size: number }
      >
    >;
    readonly sample: BindGroup;
  };
  readonly visibility: Awaited<ReturnType<typeof createGlobalSdfTexture>>;
  readonly canonical: Awaited<ReturnType<typeof createSdfSceneTextureProjection>>;
  readonly visibilityInputs: { readonly buffer: Buffer; readonly size: number };
  readonly composite: Extract<
    Awaited<ReturnType<typeof createRayDiffuseComposite>>,
    { ok: true }
  >['value'];
  /** Gather demand changes retain this field's probe and Card history. */
  gather(): FieldGatherPreparation;
  prepareGather(requested: boolean): void;
  /** Optional pipelines are generation-local and share the base field sample layout. */
  reflection(): FieldReflectionPreparation;
  prepareReflections(requested: boolean): void;
  /** Region composition is one-shot; it flips after a physical submit. */
  readonly composeRequired: () => boolean;
  /** Card capture is progressive: at most `cards.budget` tiles per submitted frame. */
  readonly capture: () => CardAtlasCapture;
  readonly capturedTiles: () => number;
  /** The last submitted frame's Card work, in tiles. */
  readonly cardWork: () => { readonly relit: number; readonly radiated: number };
  recordCapture(
    pass: RhiRenderPassEncoder,
    phase: import('./surface-cards').CardCapturePhase,
  ): void;
  recordReceiverFacts(encoder: Pick<RhiCommandEncoder, 'copyBufferToBuffer'>): void;
  /**
   * This attempt's work sizes. `tiles` is the radiosity range; `direct` says the
   * same range is also re-surfaced and directly lit: a capture slice, or every
   * tile after a light change or edit. Otherwise Card direct light is a pure
   * function of unchanged captures, lights and scene, so it is skipped.
   */
  readonly schedule: () => {
    readonly tiles: number;
    readonly direct: boolean;
    readonly probes: number;
  };
  /** Compose invocations: an edit recomposes only its box of voxels. */
  readonly composeDispatch: () => number;
  /** GPU Scene content this field reflects; in-place edits advance it. */
  content: SceneContentCursor;
  /** Accepted scene identity and content, including only its consumed assets. */
  retained: NonNullable<PersistentGpuDrivenState['retained']>;
  /**
   * Applies a scene delta in place. `deferred` means Card admission (digests and
   * shader compiles) is still running: keep the field and retry the diff later.
   */
  edit(edit: FieldEdit): 'applied' | 'deferred' | 'rebuild';
  readonly editState: ReturnType<typeof fieldEditState>;
  /**
   * Applies this frame's budget shares and streams Card residency against the
   * active view focuses. Runs in `prepare`, after the previous attempt committed.
   */
  allocate(
    share: (total: number) => number,
    focuses: readonly (readonly [number, number, number])[],
  ): void;
  readonly share: () => {
    readonly probes: number;
    readonly captureTiles: number;
    readonly relightTiles: number;
  };
  readonly residency: CardResidency | undefined;
  /** {@link SceneFieldRows.revision} this field's roster last adopted. */
  fieldRevision: number;
  editStats(): Omit<IrradianceFieldEditStats, 'skippedProjections' | 'projectedSources'>;
  /** Whether pending Field work can retain pixel history with qualified motion. */
  screenProbeHistory(): 'stable' | 'local-motion' | 'invalid';
  adoptMaterials(
    frame: NonNullable<PersistentGpuDrivenState['retained']>['materials'],
    previous: NonNullable<PersistentGpuDrivenState['retained']>['materials'],
  ): boolean;
  adoptAsset(scope: RenderResourceScope, change: AssetChange): void;
  pendingMaterialCapture(): boolean;
  extent(): IrradianceFieldExtent;
  /** Upload this attempt's schedule/lights. Failed submits do not advance offsets. */
  writeFrame(): void;
  markEncoded(stage: 'compose' | 'canonical'): void;
  track(completed: Promise<unknown>): void;
  commit(): void;
  retire(): void;
}

const storage = 128 | 12;

/** Renderer-owned Irradiance Field (Lumen-Lite diffuse GI). Generation changes
 * on scene/material/profile identity and resets all probe history; lights and
 * extent are per-frame inputs that never discard the field. */
export class RendererIrradianceField {
  #input: IrradianceFieldFrameInput | undefined;
  #key = '';
  #generation = 0;
  #pending = false;
  #ready: PreparedIrradianceField | undefined;
  #error:
    | {
        readonly cause: RhiError;
        readonly retained: PersistentGpuDrivenState['retained'];
        readonly gatherView: boolean;
      }
    | undefined;
  #disposed = false;
  #selection:
    | {
        readonly device: RenderSystemInternals['device'];
        readonly traversal: WorldTraversal;
        readonly current: () => boolean;
      }
    | undefined;
  #submitted = 0;
  #skippedProjections = 0;
  #projectedSources = 0;
  /** The field roster, kept current from scene row changes for every generation. */
  readonly #fieldRows = new SceneFieldRows();
  #receiverCache:
    | {
        readonly field: PreparedIrradianceField;
        readonly raster: VisibleSurfaceProjection;
        readonly retained: PreparedIrradianceField['retained'];
        readonly placement: ProbeGlobalRegion['placement']['current'];
        readonly expected: PreparedIrradianceField['canonical']['expected'];
        readonly result: Result<FieldReceiverFrame, RhiError>;
      }
    | undefined;
  #lights: Uint8Array = new Uint8Array(IRRADIANCE_FIELD_LIGHTS_BYTES);
  #lightCount = 0;
  #directionalLightPeak = 0;
  #excludedAreaLights = 0;

  get ready(): PreparedIrradianceField | undefined {
    const ready = this.#current();
    if (this.#input?.gatherView && ready?.view.gatherField === undefined) return undefined;
    return ready;
  }

  /** Pipeline demand only: this is not a ready resource or receiver credential.
   * Keep demand across in-place content edits; data admission retains its own
   * stricter retained/epoch/pose checks. No second traversal selection is made. */
  get plannedTraversal(): WorldTraversal | undefined {
    const selected = this.#selection;
    return !this.#disposed &&
      this.#error === undefined &&
      (this.#pending || this.#ready !== undefined) &&
      selected !== undefined &&
      selected.device === this.#input?.runtime.device &&
      selected.current()
      ? selected.traversal
      : undefined;
  }

  /** Screen pipeline demand. The published field still governs graph resources. */
  get plannedFarRadiance(): boolean {
    return this.#input?.farRadiance === true;
  }

  #receivers(field: PreparedIrradianceField): Result<FieldReceiverFrame, RhiError> {
    const input = this.#input,
      raster = input?.visibleSurface;
    if (input === undefined || this.#current() !== field)
      return ok(unavailableFieldReceivers('field-not-ready'));
    if (raster === undefined) return ok(unavailableFieldReceivers('raster-unavailable'));
    const witness = raster.source;
    // Validate before decoding borrowed rows, whose backing may already be reused.
    if (
      witness === undefined ||
      witness.identity !== field.retained.identity ||
      witness.revision !== field.retained.revision ||
      !witness.current()
    )
      return ok(unavailableFieldReceivers('stale-source'));
    const placement = field.region.placement.current,
      expected = field.canonical.expected;
    const cached = this.#receiverCache;
    if (
      cached?.field === field &&
      cached.raster === raster &&
      cached.retained === field.retained &&
      cached.placement === placement &&
      cached.expected === expected
    )
      return cached.result;
    const result: Result<FieldReceiverFrame, RhiError> = deriveFieldReceivers({
      owner: {
        identity: field,
        current: () =>
          this.#current() === field &&
          this.#input?.visibleSurface === raster &&
          this.#receiverCache?.result === result &&
          witness.current(),
      },
      raster,
      placement,
      acceptedSource: expected,
      state: field.editState,
      sources: this.#fieldRows.receiverSources(),
      sourceScope: input.sourceScope,
    });
    this.#receiverCache = { field, raster, retained: field.retained, placement, expected, result };
    return result;
  }

  #current(): PreparedIrradianceField | undefined {
    const ready = this.#ready;
    // A deferred Card edit keeps its resources for retry, but cannot expose the
    // previous scene as ready while asynchronous material admission is pending.
    return ready !== undefined &&
      ready.fence.currentGeneration() === ready.generation &&
      ready.retained.identity === this.#input?.scene.retained?.identity &&
      ready.retained.revision === this.#input?.scene.retained?.revision
      ? ready
      : undefined;
  }

  inspect(): IrradianceFieldInspection {
    const ready = this.ready;
    const reflection = ready?.reflection();
    const reflections = this.#input?.profile.reflections !== undefined;
    const error =
      this.#error?.cause ??
      this.#gatherError() ??
      (reflections && reflection?.state === 'failed' ? reflection.cause : undefined);
    return {
      gather: 'irradiance-field',
      state: error
        ? 'failed'
        : ready &&
            !ready.pendingMaterialCapture() &&
            (!reflections || reflection?.state === 'ready')
          ? 'ready'
          : 'preparing',
      generation: this.#generation,
      submittedFrames: this.#submitted,
      pixelCount: this.#input ? this.#input.width * this.#input.height : 0,
      ...(ready === undefined
        ? {}
        : {
            probes: {
              dimensions: ready.plan.dimensions,
              count: ready.plan.probeCount,
              perFrame: ready.plan.probeBudget,
              raysPerProbe: ready.plan.raysPerProbe,
              clipmap: ready.clipmap.inspect(),
            },
            cards: {
              tiles: ready.tileCount,
              captured: ready.capturedTiles(),
              perFrame: Math.min(
                ready.plan.cardBudget,
                Math.ceil(ready.tileCount / irradianceFieldRadiosityPeriod(ready.plan)),
              ),
              ...ready.cardWork(),
            },
            traversal: ready.traversal,
            ...(ready.traversalFallback === undefined
              ? {}
              : { traversalFallback: ready.traversalFallback }),
            ...(ready.acceleration === undefined
              ? {}
              : { acceleration: ready.acceleration.inspect() }),
            edits: {
              ...ready.editStats(),
              skippedProjections: this.#skippedProjections,
              projectedSources: this.#projectedSources,
            },
            ...(ready.residency === undefined ? {} : { residency: ready.residency.inspect() }),
            share: { views: this.#input?.runtime.giBudget?.views ?? 1, ...ready.share() },
          }),
      ...(this.#excludedAreaLights === 0 ? {} : { excludedAreaLights: this.#excludedAreaLights }),
      ...(error === undefined
        ? {}
        : {
            error: {
              code: error.code,
              expected: error.expected,
              hint: error.hint,
              detail: error.detail,
            },
          }),
    };
  }

  #gatherError(): RhiError | undefined {
    const gather = this.#current()?.gather();
    return this.#input?.gatherView && gather?.state === 'failed' ? gather.cause : undefined;
  }

  #failureChanged(input: IrradianceFieldFrameInput): boolean {
    const failed = this.#error;
    const retained = input.scene.retained;
    return (
      failed !== undefined &&
      (failed.retained?.identity !== retained?.identity ||
        failed.retained?.revision !== retained?.revision ||
        (failed.gatherView && !input.gatherView))
    );
  }

  #signature(): string {
    const input = this.#input;
    if (input === undefined) return '';
    return JSON.stringify([
      recordContext(input.runtime).deviceScope.generation,
      IRRADIANCE_FIELD_META_ENCODING,
      // Scene content edits are diffed against the field rows (`#sync`), not keyed.
      input.sourceScope.identity,
      // A producer-domain change replaces its buffers rather than reinterpreting old history.
      input.farRadiance === true,
      input.profile.maxDistance,
      input.profile.environment,
      input.profile.field,
    ]);
  }

  readonly #pendingAssets = new Map<number, AssetChange>();
  #pendingScope: RenderResourceScope | undefined;

  adoptAsset(scope: RenderResourceScope, change: AssetChange): void {
    if (this.#disposed) return;
    this.#ready?.adoptAsset(scope, change);
    if (!this.#pending || scope !== this.#pendingScope) return;
    this.#pendingAssets.set(change.handle, change);
  }

  prepare(input: IrradianceFieldFrameInput): void {
    if (this.#disposed) return;
    const sceneChanged = this.#input?.scene.scene !== input.scene.scene;
    this.#input = input;
    let key: string;
    try {
      key = this.#signature();
      // The probe/Card ray reference has no area-light sampling; area lights stay
      // direct-only instead of failing the whole field.
      const admitted = input.lights.filter((light) => light.kind !== 'rect-area');
      const lights = packLights(admitted).unwrap();
      this.#lights = new Uint8Array(IRRADIANCE_FIELD_LIGHTS_BYTES);
      this.#lights.set(lights.subarray(0, Math.min(lights.byteLength, this.#lights.byteLength)));
      this.#lightCount = admitted.length;
      const directional = admitted.find((light) => light.kind === 'directional');
      this.#directionalLightPeak = directional === undefined ? 0 : Math.max(...directional.color);
      this.#excludedAreaLights = input.lights.length - admitted.length;
    } catch (cause) {
      this.#fail(input, cause);
      return;
    }
    const ready = this.#ready;
    let synchronized = true;
    try {
      if (!sceneChanged && key === this.#key && ready !== undefined)
        synchronized = this.#sync(ready, input);
    } catch (cause) {
      this.#fail(input, cause);
      return;
    }
    if (sceneChanged || key !== this.#key || this.#failureChanged(input) || !synchronized) {
      this.#generation++;
      this.#key = key;
      this.#ready?.retire();
      this.#ready = undefined;
      this.#error = undefined;
      this.#submitted = 0;
      this.#skippedProjections = 0;
      this.#projectedSources = 0;
    }
    // Gather preparation can make this generation temporarily unavailable to
    // graph consumers while its existing probe/Card history remains retained.
    const current = this.#current();
    if (current !== undefined) {
      const budget = input.runtime.giBudget;
      budget?.claim(this, input.runtime.rendererFrameNumber ?? 0, input.focus);
      try {
        current.prepareGather(input.gatherView);
        current.prepareReflections(input.profile.reflections !== undefined);
        current.allocate(
          (total) => budget?.share(this, total) ?? total,
          budget?.focuses() ?? [input.focus],
        );
      } catch (cause) {
        this.#fail(input, cause);
        return;
      }
    }
    if (this.#pending || this.#ready || this.#error) return;
    this.#pending = true;
    this.#pendingScope = input.sourceScope;
    const generation = this.#generation;
    let cards: ProbeCardCapture | undefined;
    // Cleanup retires candidate resources before a rejected build reaches its
    // caller. Source validity must not depend on those already retired Cards.
    const sourceCurrent = () => {
      if (this.#disposed || this.#generation !== generation) return false;
      try {
        return this.#signature() === this.#key;
      } catch {
        return false;
      }
    };
    const fence: RendererGenerationFence = {
      capturedGeneration: generation,
      currentGeneration: () => {
        try {
          return sourceCurrent() && cards?.current() !== false ? generation : -1;
        } catch {
          return -1;
        }
      },
    };
    void this.#build(
      input,
      fence,
      (value) => {
        cards = value;
      },
      (traversal) => {
        this.#selection = { device: input.runtime.device, traversal, current: sourceCurrent };
      },
    )
      .then(
        (candidate) => {
          try {
            for (const change of this.#pendingAssets.values())
              candidate.adoptAsset(input.sourceScope, change);
            this.#pendingAssets.clear();
            const current = this.#input;
            if (
              fence.currentGeneration() === generation &&
              current !== undefined &&
              this.#sync(candidate, current)
            ) {
              candidate.prepareGather(current.gatherView);
              this.#ready = candidate;
            } else candidate.retire();
          } catch (cause) {
            // Retirement can invalidate cards.current(). Capture the source
            // generation independently before releasing the failed candidate.
            const current = this.#input;
            const report = sourceCurrent() && current !== undefined;
            candidate.retire();
            if (report) this.#fail(current, cause);
          }
        },
        (cause) => {
          if (sourceCurrent()) this.#fail(input, cause);
        },
      )
      .finally(() => {
        this.#pending = false;
        this.#pendingScope = undefined;
        this.#pendingAssets.clear();
      });
  }

  /** Bring a prepared field to the current scene revision by an in-place edit. */
  #sync(field: PreparedIrradianceField, input: IrradianceFieldFrameInput): boolean {
    const content = input.scene.scene.contentCursor;
    const retained = input.scene.retained;
    if (retained === undefined || !retained.isCurrent()) return false;
    // A replacement CPU projection can restart its revision while keeping the
    // same GPU tables. Revisions are comparable only within that scene identity.
    const sameScene = field.retained.identity === retained.identity;
    if (sameScene && field.retained.revision === retained.revision) return true;
    const materialsChanged = field.retained.materials !== retained.materials;
    if (materialsChanged && !field.adoptMaterials(retained.materials, field.retained.materials))
      return false;
    if (!retained.isSourceCurrent()) return false;
    // Only changed scene rows are re-admitted; an unchanged roster skips the edit diff.
    const visits = this.#fieldRows.visits;
    const projected = this.#fieldRows.changes(
      retained,
      input.sourceScope,
      input.profile.field.region,
      input.runtime.assets,
    );
    this.#projectedSources += this.#fieldRows.visits - visits;
    if (!projected.ok || !retained.isSourceCurrent()) return false;
    if (field.fieldRevision === this.#fieldRows.revision) {
      field.content = content;
      field.retained = retained;
      this.#skippedProjections++;
      return true;
    }
    const edit = diffFieldEdit(field.editState, projected.value);
    const applied = field.edit(edit);
    if (applied === 'rebuild') return false;
    if (applied === 'applied') {
      field.content = content;
      field.retained = retained;
      field.fieldRevision = this.#fieldRows.revision;
      this.#fieldRows.acceptChanges(field.fieldRevision);
    }
    return true;
  }

  #fail(input: IrradianceFieldFrameInput, cause: unknown): void {
    const retained = input.scene.retained;
    const current = this.#input?.scene.retained;
    // Async preparation can reject after a newer source was accepted. Such a
    // failure belongs to the old input and must not block the current one.
    if (retained?.identity !== current?.identity || retained?.revision !== current?.revision)
      return;
    this.#ready?.retire();
    this.#ready = undefined;
    const error = fieldPreparationError(cause);
    this.#error = { cause: error, retained, gatherView: input.gatherView };
    input.runtime.errorRegistry.fire(error);
  }

  async #build(
    input: IrradianceFieldFrameInput,
    fence: RendererGenerationFence,
    publishCards: (cards: ProbeCardCapture) => void,
    publishSelection: (traversal: WorldTraversal) => void,
  ): Promise<PreparedIrradianceField> {
    const { runtime, profile } = input;
    const content = input.scene.scene.contentCursor;
    const retained = input.scene.retained;
    if (retained === undefined) throw new Error('irradiance-field GI requires an accepted scene');
    const device = runtime.device;
    const shaders = runtime.shaderRegistry;
    const compile = runtime.createShaderModule;
    if (shaders === undefined || compile === undefined)
      throw new Error('irradiance-field GI requires the ordinary shader registry and compiler');
    const plan = planIrradianceField(profile.field).unwrap();
    const entries = [...shaders.entries()];

    const viewSource = requirePublishedKernel(entries, 'gatherField', 'standard-gbuffer/2');
    const compositeSource = requirePublishedKernel(entries, 'fs_ray_diffuse', 'standard-gbuffer/2');
    const field = profile.field;
    const region = await prepareProbeGlobalRegion(
      runtime,
      { scene: input.scene, sourceScope: input.sourceScope, lease: input.lease },
      {
        ...field.region,
        rayResolution: 1,
        tMax: profile.maxDistance,
        cards: field.cards,
      },
      true,
      input.focus,
      this.#fieldRows,
    );
    const owned: Buffer[] = [];
    let extent: IrradianceFieldExtent | undefined;
    let acceleration: PreparedWorldAcceleration | undefined;
    let visibility: Awaited<ReturnType<typeof createGlobalSdfTexture>> | undefined;
    let canonical: Awaited<ReturnType<typeof createSdfSceneTextureProjection>> | undefined;
    const destroy = () => {
      for (const buffer of owned) device.destroyBuffer(buffer);
      if (visibility !== undefined) device.destroyTexture(visibility.texture);
      canonical?.dispose();
      acceleration?.dispose();
      region.lifetime.retire();
    };
    try {
      visibility = await createGlobalSdfTexture(
        device,
        (
          await compile(device, {
            code: GLOBAL_SDF_TEXTURE_WGSL,
            label: 'irradiance-field.visibility',
          })
        ).unwrap(),
        region,
      );
      canonical = await createSdfSceneTextureProjection(
        device,
        (
          await compile(device, {
            code: SDF_SCENE_TEXTURE_PROJECT_WGSL,
            label: 'irradiance-field.canonical-projection',
          })
        ).unwrap(),
        region.input,
        region.placement.current.instances.length,
        sceneFieldSourceEpoch(region.fieldRevision).unwrap(),
      );
      const canonicalScene = canonical;
      const cards = region.cards;
      if (cards === undefined) throw new Error('irradiance field requires native Card capture');
      cards.acceptMaterials(retained.materials);
      publishCards(cards);
      const capture = cards.capture;
      if (capture.width % plan.cardResolution !== 0)
        throw new Error('Card atlas width must be a whole number of tiles');
      // Allocated atlas high-water mark (`tiles`); adds may raise it up to `capture.capacity`.
      const captureSchedule = cards.schedule;
      const atlasTexels = capture.width * capture.height;
      const allocate = (label: string, size: number, usage = storage) => {
        const buffer = device
          .createBuffer({ label: `irradiance-field.${label}`, size, usage })
          .unwrap();
        owned.push(buffer);
        // Zero history: unwritten probes report meta.x == 0 and are skipped.
        if ((usage & 64) === 0) device.queue.writeBuffer(buffer, 0, new Uint8Array(size)).unwrap();
        return { buffer, size };
      };
      const rays = plan.probeBudget * plan.raysPerProbe;
      const limit = device.limits.maxStorageBufferBindingSize;
      const buffers = {
        field: allocate('field', IRRADIANCE_FIELD_UNIFORM_BYTES, 64 | 8),
        frame: allocate('frame', IRRADIANCE_FIELD_FRAME_BYTES, 64 | 8),
        lights: allocate('lights', IRRADIANCE_FIELD_LIGHTS_BYTES, 64 | 8),
        irradiance: allocate('irradiance', plan.probeCount * IRRADIANCE_FIELD_PROBE_BYTES),
        moments: allocate('moments', plan.probeCount * IRRADIANCE_FIELD_DEPTH_BYTES),
        meta: allocate('meta', plan.probeCount * IRRADIANCE_FIELD_META_BYTES),
        probeList: allocate('probe-list', plan.probeBudget * 4),
        probeOrigins: allocate('probe-origins', plan.probeBudget * IRRADIANCE_FIELD_ORIGIN_BYTES),
        probeRays: allocate('probe-rays', rays * IRRADIANCE_FIELD_RAY_BYTES),
        surfaces: allocate('card-surfaces', atlasTexels * IRRADIANCE_FIELD_SURFACE_BYTES),
        cardDirect: allocate('card-direct', atlasTexels * 16),
        cardLit: allocate('card-lit', atlasTexels * 16),
      };
      const visibilityInputs = allocate('visibility-inputs', 64, 64 | 8);
      const cardRadiosityPlan = planCardRadiosity(
        plan.cardResolution,
        capture.width,
        capture.height,
        field.cards.radiosity,
      );
      let radiosityEpoch = 1;
      let radiosityInvalidation = 0;
      let radiosityCaptureRevision = cards.capture.revision;
      let radiosityUpdate: CardRadiosityUpdate = { epoch: radiosityEpoch, tiles: [] };
      const cardRadiosity = field.radiosity
        ? {
            plan: cardRadiosityPlan,
            buffers: allocateCardRadiosity(cardRadiosityPlan, allocate),
            schedule: new CardRadiositySchedule(
              cardRadiosityPlan.tileCapacity,
              Math.ceil(
                cardRadiosityPlan.tileCapacity / (field.cards.radiosity?.updateFactor ?? 64),
              ),
            ),
            update: () => radiosityUpdate,
          }
        : undefined;
      device.queue
        .writeBuffer(visibilityInputs.buffer, 48, Uint32Array.from(canonicalScene.expected))
        .unwrap();
      for (const value of [
        ...Object.values(buffers),
        ...Object.values(cardRadiosity?.buffers ?? {}),
      ])
        if (value.size > limit)
          throw new Error(
            `irradiance field buffer of ${value.size} bytes exceeds the storage binding limit`,
          );
      const clipmap = new ProbeClipmapScheduler(plan, input.focus);
      device.queue
        .writeBuffer(buffers.field.buffer, 0, packIrradianceFieldUniform(plan, clipmap.windows()))
        .unwrap();
      this.#key = this.#signature();
      const accelerationIds = new WorldAccelerationGeometryIds();
      const roster = worldAccelerationRoster(region, accelerationIds);
      const selection = selectWorldTraversal(
        device.caps.rayQuery,
        region.instances.length,
        roster.geometries,
        input.profile.field.hardwareRayTracing,
      );
      const traversal = selection.traversal;
      publishSelection(traversal);
      if (traversal === 'ray-query')
        acceleration = prepareWorldAcceleration(
          device,
          roster,
          roster.geometries,
          region.headroom === undefined
            ? undefined
            : {
                instances: region.headroom.rows.capacity,
                triangles: WORLD_ACCELERATION_TRIANGLE_HEADROOM,
              },
        ).unwrap();
      const sources = irradianceFieldKernelWgsl(traversal);
      const stages = (Object.keys(sources) as IrradianceFieldKernelStage[]).filter(
        (stage): stage is FieldKernelStage => stage !== 'traceReflections',
      );
      const modules = await Promise.all([
        ...stages.map(async (stage) =>
          (
            await compile(device, {
              label: `irradiance-field.${stage}`,
              code: sources[stage],
            })
          ).unwrap(),
        ),
        (async () =>
          (await compile(device, { label: 'irradiance-field.view', code: viewSource })).unwrap())(),
        (async () =>
          (
            await compile(device, { label: 'irradiance-field.composite', code: compositeSource })
          ).unwrap())(),
      ]);
      const viewModule = modules[stages.length];
      const compositeModule = modules[stages.length + 1];
      if (viewModule === undefined || compositeModule === undefined)
        throw new Error('missing irradiance field view modules');
      // View PSOs do not consume the core kernels. Request both now, but drain
      // both branches before publication or the failure cleanup below.
      const [core, viewing] = await Promise.allSettled([
        prepareFieldKernels(device, stages, modules, traversal),
        createIrradianceFieldViewKernels(device, viewModule, 'live', {
          ...field,
          gatherView: input.gatherView,
          current: () => fence.currentGeneration() === fence.capturedGeneration,
        }),
      ]);
      if (core.status === 'rejected') throw core.reason;
      if (viewing.status === 'rejected') throw viewing.reason;
      const kernels = core.value;
      const view = viewing.value.unwrap();
      const farBuffers =
        input.farRadiance === true && traversal === 'ray-query'
          ? {
              field: allocate('far-field', IRRADIANCE_FIELD_UNIFORM_BYTES, 64 | 8 | 4),
              irradiance: allocate('far-radiance', buffers.irradiance.size),
              moments: allocate('far-moments', buffers.moments.size),
              meta: allocate('far-meta', buffers.meta.size),
            }
          : undefined;
      const visibilityView = visibility.view;
      const sampleGroup = (
        data: Pick<typeof buffers, 'field' | 'irradiance' | 'moments' | 'meta'>,
      ) =>
        device
          .createBindGroup({
            layout: view.sampleLayout,
            entries: [
              ...(['field', 'irradiance', 'moments', 'meta'] as const).map((name, binding) => ({
                binding,
                resource: { kind: 'buffer' as const, value: data[name] },
              })),
              { binding: 4, resource: { kind: 'buffer', value: visibilityInputs } },
              { binding: 5, resource: { kind: 'textureView', value: visibilityView } },
              { binding: 6, resource: { kind: 'textureView', value: canonicalScene.view } },
            ],
          })
          .unwrap();
      const sample = sampleGroup(buffers);
      const farRadiance =
        farBuffers === undefined
          ? undefined
          : { buffers: farBuffers, sample: sampleGroup(farBuffers) };
      const composite = (
        await createRayDiffuseComposite(device, compositeModule, 'reconstructed')
      ).unwrap();
      let reflection: FieldReflectionPreparation = { state: 'unrequested' };
      let reflectionRequested = false;
      let retired = false;
      const reflectionCurrent = () =>
        !retired && fence.currentGeneration() === fence.capturedGeneration;
      let gather: FieldGatherPreparation = {
        state: view.kernels.gatherField === undefined ? 'unrequested' : 'ready',
      };
      let gatherReported = false;
      const reportGatherFailure = () => {
        const current = this.#input ?? input;
        if (!gatherReported && current.gatherView && gather.state === 'failed') {
          gatherReported = true;
          current.runtime.errorRegistry.fire(gather.cause);
        }
      };
      const failGather = (cause: unknown) => {
        if (!reflectionCurrent()) return;
        gather = { state: 'failed', cause: fieldPreparationError(cause) };
        reportGatherFailure();
      };
      const prepareGather = (requested: boolean) => {
        if (!requested || !reflectionCurrent()) return;
        if (gather.state === 'failed') {
          reportGatherFailure();
          return;
        }
        if (gather.state !== 'unrequested') return;
        gather = { state: 'preparing' };
        void view.prepareGather(true).then((result) => {
          if (!reflectionCurrent()) return;
          if (!result.ok) failGather(result.error);
          else gather = { state: 'ready' };
        }, failGather);
      };
      const prepareReflections = (requested: boolean) => {
        reflectionRequested = requested;
        if (!requested) {
          if (reflection.state === 'failed') reflection = { state: 'unrequested' };
          return;
        }
        if (reflection.state !== 'unrequested' || !reflectionCurrent()) return;
        reflection = { state: 'preparing' };
        void buildFieldReflections(
          (this.#input ?? input).runtime,
          traversal,
          sources.traceReflections,
          { source: viewSource, module: viewModule, factory: view, composite },
          reflectionCurrent,
        ).then(
          (value) => {
            if (value !== undefined && reflectionCurrent()) reflection = { state: 'ready', value };
          },
          (cause) => {
            if (!reflectionCurrent()) return;
            const error = fieldPreparationError(cause);
            reflection = reflectionRequested
              ? { state: 'failed', cause: error }
              : { state: 'unrequested' };
            if (reflectionRequested) (this.#input ?? input).runtime.errorRegistry.fire(error);
          },
        );
      };
      const lifetime = new ResidencyLifetime(() => {
        extent?.lifetime.retire();
        destroy();
      });
      const half = field.resolution === 'half';
      let tileOffset = 0;
      let composeDispatch = region.voxelCount;
      const edits = {
        applied: 0,
        movedInstances: 0,
        removedInstances: 0,
        addedInstances: 0,
        rematerializedInstances: 0,
        recapturedTiles: 0,
        composedVoxels: 0,
        priorityProbes: 0,
      };
      const editState = fieldEditState(region.sources, region.instances);
      this.#fieldRows.acceptChanges(region.fieldRevision);
      const residency =
        capture.residency === undefined
          ? undefined
          : new CardResidency(device, cards, editState, region.sources, region.instances);
      // This frame's Card relight rotation, the field's share of `plan.cardBudget`.
      let relight = plan.cardBudget;
      // Capture records before the frame upload; the upload adopts its slice.
      let encodedCapture: CardCaptureSlice | undefined;
      let composeEncoded = false;
      let canonicalEncoded: number | undefined;
      let acceptedRevision = region.fieldRevision;
      // The levels follow the current view; an unchanged window keeps the schedule.
      const probeSchedule = (): ProbeFrameSchedule => {
        clipmap.focus((this.#input ?? input).focus);
        return clipmap.schedule();
      };
      let frameIndex = 0;
      // Reflection history ping-pong: the committed frame's buffer index.
      let historyIndex = 0;
      // Lights relight every tile once; budgeted rotation resumes afterwards.
      let litLights: Uint8Array | undefined;
      // Spatial edits refresh the Card lighting and schedule their own probe sweep.
      let spatialRelightPending = false;
      // Motion-only remains admissible until the entire capture/probe wave
      // commits. Other work joining the wave invalidates that qualification.
      let localMotionOnly = false;
      let committedDirectionalPeak: number | undefined;
      const hasPendingEdits = () =>
        captureSchedule.pendingTiles > 0 || clipmap.pendingPriorityUpdates() > 0;
      const globalLightChanged = () => {
        if (committedDirectionalPeak === undefined) return false;
        // Lumen tests the first indirect directional light's peak ratio.
        const ratio =
          Math.max(committedDirectionalPeak, 1e-5) / Math.max(this.#directionalLightPeak, 1e-5);
        return ratio > 4 || ratio < 0.25;
      };
      // Probe updates since the last global relight. Local edits use the priority
      // sweep's history weight after their new Cards are published.
      let probesSinceDirect = 0;
      let cardWork = { relit: 0, radiated: 0 };
      let attempt:
        | {
            lights: Uint8Array;
            directionalPeak: number;
            full: boolean;
            restartProbeHistory: boolean;
            work: { relit: number; radiated: number };
            slice: CardCaptureSlice | undefined;
            probes: ProbeFrameSchedule;
            composed: boolean;
            canonicalEpoch: number | undefined;
            radiosity: CardRadiosityUpdate | undefined;
          }
        | undefined;
      const pendingBounds: Parameters<typeof globalSdfEditBox>[1][number][] = [];
      let admitting = false;
      let admissionFailed = false;
      const prepareEditMaterials = (edit: FieldEdit): 'ready' | 'deferred' | 'rebuild' => {
        // Card installs need async digests and shader modules; apply once admitted.
        const installs = [...edit.added, ...edit.rematerialized];
        if (installs.length > 0) {
          if (admitting) return 'deferred';
          let missing: ReturnType<ProbeCardCapture['lower']>[];
          try {
            missing = installs
              .map((c) => cards.lower(c.source, c.instance, 0))
              .filter((lowered) => !cards.capture.admitted(lowered));
          } catch {
            return 'rebuild';
          }
          if (missing.length > 0) {
            admitting = true;
            void Promise.all(missing.map((lowered) => cards.capture.admit(lowered)))
              .then(
                (results) => {
                  if (results.some((r) => !r.ok)) admissionFailed = true;
                },
                () => {
                  admissionFailed = true;
                },
              )
              .finally(() => {
                admitting = false;
              });
            return 'deferred';
          }
        }
        return 'ready';
      };
      const lightInputsChanged = () =>
        litLights === undefined ||
        litLights.byteLength !== this.#lights.byteLength ||
        litLights.some((value, i) => value !== this.#lights[i]);
      const full = () => spatialRelightPending || lightInputsChanged();
      // Static lights and scene: direct light is cached, so radiosity re-gathers
      // the slowly converging field for a rotating fraction of tiles per frame.
      const radiosityPeriod = irradianceFieldRadiosityPeriod(plan);
      const steadyTiles = (tileCount: number) =>
        Math.min(
          relight,
          probesSinceDirect >= IRRADIANCE_FIELD_RELIGHT_SWEEPS.length * plan.probeCount
            ? Math.ceil(tileCount / radiosityPeriod)
            : tileCount,
        );
      // A capturing frame surfaces and lights exactly its fresh slice; the first
      // frame after the last slice relights every tile with the current lights.
      const schedule = () => {
        const slice = captureSchedule.slice();
        const tileCount = captureSchedule.tiles;
        return {
          offset: slice !== undefined ? slice.first : full() ? 0 : tileOffset,
          tiles: slice !== undefined ? slice.count : full() ? tileCount : steadyTiles(tileCount),
          direct: slice !== undefined || full(),
          probes: probeSchedule().count,
        };
      };
      const resize = (): IrradianceFieldExtent => {
        const current = this.#input ?? input;
        const { width, height, gatherView } = current;
        const reflections =
          current.profile.reflections !== undefined && reflection.state === 'ready';
        if (
          extent !== undefined &&
          extent.width === width &&
          extent.height === height &&
          (extent.gathered !== undefined) === gatherView &&
          (extent.reflection !== undefined) === reflections
        )
          return extent;
        const gatherWidth = half ? Math.ceil(width / 2) : width;
        const gatherHeight = half ? Math.ceil(height / 2) : height;
        if (
          width *
            height *
            (reflections
              ? Math.max(
                  IRRADIANCE_FIELD_REFLECTION_RAY_BYTES,
                  IRRADIANCE_FIELD_REFLECTION_HISTORY_BYTES,
                )
              : 16) >
          limit
        )
          throw new Error('irradiance field view buffers exceed the storage binding limit');
        const created: Buffer[] = [];
        const make = (label: string, size: number) => {
          const buffer = device
            .createBuffer({ label: `irradiance-field.${label}`, size, usage: storage })
            .unwrap();
          created.push(buffer);
          return buffer;
        };
        extent?.lifetime.retire();
        const history = reflections
          ? ([0, 1] as const).map((index) =>
              make(
                `reflection-history-${index}`,
                width * height * IRRADIANCE_FIELD_REFLECTION_HISTORY_BYTES,
              ),
            )
          : [];
        extent = {
          width,
          height,
          gatherWidth,
          gatherHeight,
          gathered: gatherView ? make('gathered', gatherWidth * gatherHeight * 16) : undefined,
          upsampled: gatherView && half ? make('upsampled', width * height * 16) : undefined,
          reflection: reflections
            ? {
                rays: make(
                  'reflection-rays',
                  width * height * IRRADIANCE_FIELD_REFLECTION_RAY_BYTES,
                ),
                signal: make('reflection-signal', width * height * 16),
                denoised: make('reflection-denoised', width * height * 16),
                history: () => {
                  const previous = history[historyIndex];
                  const current = history[1 - historyIndex];
                  if (previous === undefined || current === undefined)
                    throw new Error('irradiance field lost its reflection history');
                  return { previous, current };
                },
              }
            : undefined,
          lifetime: new ResidencyLifetime(() => {
            for (const buffer of created) device.destroyBuffer(buffer);
          }),
        };
        return extent;
      };
      resize();
      const receiverFrame = () =>
        retired ? ok(unavailableFieldReceivers('field-not-ready')) : this.#receivers(prepared);
      const prepared: PreparedIrradianceField = {
        generation: fence.capturedGeneration,
        fence,
        plan,
        region,
        get receivers() {
          return receiverFrame();
        },
        visibility,
        canonical: canonicalScene,
        visibilityInputs,
        cards,
        clipmap,
        get tileCount() {
          return captureSchedule.tiles;
        },
        half,
        traversal,
        traversalFallback: selection.traversal === 'global-sdf' ? selection.fallback : undefined,
        acceleration,
        buffers,
        cardRadiosity,
        kernels,
        view: view.kernels,
        sample,
        ...(farRadiance === undefined ? {} : { farRadiance }),
        composite,
        gather: () => gather,
        prepareGather,
        reflection: () => reflection,
        prepareReflections,
        composeRequired: () => !region.composed,
        capture: () => captureSchedule.mode(),
        capturedTiles: () => captureSchedule.captured,
        cardWork: () => cardWork,
        recordCapture: (pass, phase) => {
          const slice = captureSchedule.slice();
          if (slice === undefined) return;
          if (slice.clear || phase === 'identity')
            cards.capture.clearTiles(pass, slice, phase).unwrap();
          cards.capture.recordPass(pass, slice, phase).unwrap();
          if (phase === 'identity') encodedCapture = slice;
        },
        recordReceiverFacts: (encoder) => {
          const work = schedule();
          capture
            .recordReceiverFacts(
              encoder,
              { expected: canonicalScene.expected, instances: region.placement.current.instances },
              { first: work.offset, count: work.tiles },
              encodedCapture ?? attempt?.slice,
            )
            .unwrap();
        },
        schedule,
        composeDispatch: () => composeDispatch,
        content,
        retained,
        editState,
        residency,
        allocate: (share, focuses) => {
          clipmap.limit = share(plan.probeBudget);
          captureSchedule.limit = share(captureSchedule.budget);
          relight = share(plan.cardBudget);
          if (residency?.stream(focuses, captureSchedule, captureSchedule.limit))
            localMotionOnly = false;
          const slice = captureSchedule.slice();
          if (slice !== undefined) capture.prepareTiles(slice);
        },
        share: () => ({
          probes: clipmap.limit,
          captureTiles: captureSchedule.limit,
          relightTiles: Math.min(relight, captureSchedule.tiles),
        }),
        get fieldRevision() {
          return acceptedRevision;
        },
        set fieldRevision(value: number) {
          if (value !== acceptedRevision && cardRadiosity !== undefined)
            cardRadiosity.schedule.invalidate([{ first: 0, end: cardRadiosity.plan.tileCapacity }]);
          const sourceEpoch = sceneFieldSourceEpoch(value).unwrap();
          adoptFieldSourceEpoch(device, region, sourceEpoch, () => canonicalScene.invalidate());
          canonicalScene.adopt(sourceEpoch, region.placement.current.instances.length);
          device.queue
            .writeBuffer(visibilityInputs.buffer, 48, Uint32Array.from(canonicalScene.expected))
            .unwrap();
          acceptedRevision = value;
        },
        pendingMaterialCapture: () => captureSchedule.pendingWork,
        adoptAsset: (scope, change) => {
          const work = capture.adoptAsset(scope, change.handle, change.revision);
          if (work === undefined) return;
          captureSchedule.queueWork(work);
          localMotionOnly = false;
          if (cardRadiosity !== undefined)
            cardRadiosity.schedule.invalidate([{ first: 0, end: cardRadiosity.plan.tileCapacity }]);
          litLights = undefined;
        },
        adoptMaterials: (frame, previous) => {
          let valid = true;
          let changed = false;
          frame.changesSince(previous, (before, after) => {
            if (!valid) return;
            // Losing the last scene binding is handled by the actual topology edit.
            if (after === undefined) return;
            if (before?.snapshot === after.snapshot) return;
            const accepted = capture.adoptMaterial(after.resource, after.snapshot);
            if (!accepted.ok) {
              valid = false;
              return;
            }
            if (accepted.value !== undefined) {
              captureSchedule.queueWork(accepted.value);
              if (!changed && cardRadiosity !== undefined)
                cardRadiosity.schedule.invalidate([
                  { first: 0, end: cardRadiosity.plan.tileCapacity },
                ]);
              changed = true;
            }
          });
          if (!valid) return false;
          cards.acceptMaterials(frame);
          if (changed) {
            localMotionOnly = false;
            litLights = undefined;
          }
          return true;
        },
        screenProbeHistory: () => {
          if (globalLightChanged()) return 'invalid';
          if (!hasPendingEdits()) return 'stable';
          return localMotionOnly ? 'local-motion' : 'invalid';
        },
        editStats: () => ({
          ...edits,
          materialRootUpdates: capture.materialWork.roots,
          materialDrawVisits: capture.materialWork.drawVisits,
          materialUniformUploads: capture.materialWork.uniformUploads,
          assetRootUpdates: capture.materialWork.assetRoots,
          materialBindingRefreshes: capture.materialWork.bindingRefreshes,
          pendingTiles: captureSchedule.pendingTiles,
          pendingPriorityUpdates: clipmap.pendingPriorityUpdates(),
        }),
        edit: (edit) => {
          if (
            edit.moved.length +
              edit.removed.length +
              edit.added.length +
              edit.rematerialized.length ===
            0
          )
            return 'applied';
          if (admissionFailed) return 'rebuild';
          // A failed physical edit invalidates the complete derived region.
          try {
            const admission = prepareEditMaterials(edit);
            if (admission !== 'ready') return admission;
            const written = writeFieldEdit(
              device,
              region,
              cards,
              edit,
              editState,
              sceneFieldSourceEpoch(this.#fieldRows.revision).unwrap(),
              () => canonicalScene.invalidate(),
            );
            // Geometry edits build acceleration; material coverage edits update only placement data.
            if (acceleration !== undefined) {
              const delta = worldAccelerationEdit(edit, written.added, accelerationIds);
              if (!delta.ok || !acceleration.edit(delta.value).ok) return 'rebuild';
            }
            const transformOnly =
              edit.moved.length > 0 &&
              edit.removed.length === 0 &&
              edit.added.length === 0 &&
              edit.rematerialized.length === 0;
            const retainMotion =
              transformOnly &&
              (localMotionOnly ||
                (!hasPendingEdits() && captureSchedule.done && !spatialRelightPending));
            adoptFieldEdit(editState, edit, written.added);
            residency?.applyEdit(edit, written.added);
            const captured = captureSchedule.captured;
            const queued = captureSchedule.queue(written.tiles);
            // Added tiles past the frontier extend it; they are new capture work too.
            const fresh = written.addedTiles.reduce(
              (n, run) => n + Math.max(0, run.end - Math.max(run.first, captured)),
              0,
            );
            captureSchedule.grow(capture.allocatedTiles);
            if (written.bounds.length > 0) {
              pendingBounds.push(...written.bounds);
              const box = globalSdfEditBox(region.grid, pendingBounds);
              composeDispatch =
                box === undefined
                  ? region.voxelCount
                  : box.extent[0] * box.extent[1] * box.extent[2];
              device.queue
                .writeBuffer(
                  region.input.settings.buffer,
                  40,
                  new Uint8Array(packGlobalSdfEditBox(box).buffer),
                )
                .unwrap();
              if (composeDispatch > 0) region.composed = false;
            }
            clipmap.queueEdit(written.probeBounds);
            // Shadows/bounces of unedited tiles changed too: relight all once recaptured.
            if (written.probeBounds.length > 0) spatialRelightPending = true;
            else litLights = undefined;
            written.publish();
            localMotionOnly = retainMotion;
            edits.applied++;
            edits.movedInstances += edit.moved.length;
            edits.removedInstances += edit.removed.length;
            edits.addedInstances += edit.added.length;
            edits.rematerializedInstances += edit.rematerialized.length;
            edits.recapturedTiles += queued + fresh;
            edits.composedVoxels = written.bounds.length > 0 ? composeDispatch : 0;
            edits.priorityProbes = clipmap.priorityProbes();
            return 'applied';
          } catch {
            return 'rebuild';
          }
        },
        extent: resize,
        writeFrame: () => {
          const current = resize();
          const work = schedule();
          const probes = probeSchedule();
          const reflections = (this.#input ?? input).profile.reflections;
          const relightAll = captureSchedule.slice() === undefined && full();
          const restartProbeHistory = work.direct && lightInputsChanged();
          attempt = {
            lights: this.#lights,
            directionalPeak: this.#directionalLightPeak,
            full: relightAll,
            restartProbeHistory,
            work: { relit: work.direct ? work.tiles : 0, radiated: work.tiles },
            slice: encodedCapture,
            probes,
            composed: composeEncoded,
            canonicalEpoch: canonicalEncoded,
            radiosity: undefined,
          };
          if (cardRadiosity !== undefined) {
            // Minor changes to the same directional light can relight the direct
            // term while the budget refreshes indirect pages. Geometry, materials,
            // other light edits and global lighting changes still retire old SH.
            const directSourceChanged =
              work.direct &&
              (litLights === undefined ||
                spatialRelightPending ||
                globalLightChanged() ||
                !onlyPrimaryDirectionalColorChanged(litLights, this.#lights));
            if (
              directSourceChanged ||
              radiosityInvalidation !== cardRadiosity.schedule.invalidation ||
              radiosityCaptureRevision !== cards.capture.revision
            ) {
              // Do not wrap into an epoch still present in retained GPU history.
              if (radiosityEpoch === 0xffffffff)
                throw new Error('Card radiosity epoch exhausted; rebuild the field allocation');
              radiosityEpoch++;
              radiosityInvalidation = cardRadiosity.schedule.invalidation;
              radiosityCaptureRevision = cards.capture.revision;
            }
            radiosityUpdate = cardRadiosity.schedule.select(radiosityEpoch, captureSchedule.tiles);
            attempt.radiosity = radiosityUpdate;
            const upload = cardRadiosity.buffers;
            device.queue
              .writeBuffer(
                upload.frame.buffer,
                0,
                packCardRadiosityFrame(
                  cardRadiosity.plan,
                  radiosityUpdate,
                  frameIndex,
                  captureSchedule.tiles,
                  capture.width,
                ),
              )
              .unwrap();
            if (radiosityUpdate.tiles.length > 0)
              device.queue
                .writeBuffer(upload.pages.buffer, 0, Uint32Array.from(radiosityUpdate.tiles))
                .unwrap();
          }
          encodedCapture = undefined;
          composeEncoded = false;
          canonicalEncoded = undefined;
          const fieldUniform = packIrradianceFieldUniform(
            plan,
            clipmap.windows(),
            farBuffers !== undefined,
          );
          // This frame's adopted scene bounds prove whether segment portions
          // outside the stored SDF box contain no geometry; never infer from voxels.
          const fieldWords = new Uint32Array(fieldUniform.buffer);
          const outside = fieldOutsideEmpty(editState, region.grid)
            ? IRRADIANCE_FIELD_OUTSIDE_EMPTY
            : 0;
          fieldWords[15] = outside;
          device.queue.writeBuffer(buffers.lights.buffer, 0, this.#lights).unwrap();
          device.queue
            .writeBuffer(buffers.probeList.buffer, 0, probes.list.subarray(0, probes.count))
            .unwrap();
          device.queue.writeBuffer(buffers.field.buffer, 0, fieldUniform).unwrap();
          if (farBuffers !== undefined) {
            fieldWords[15] = outside | IRRADIANCE_FIELD_FAR_RADIANCE;
            device.queue.writeBuffer(farBuffers.field.buffer, 0, fieldUniform).unwrap();
          }
          device.queue
            .writeBuffer(
              buffers.frame.buffer,
              0,
              packIrradianceFieldFrame({
                probeBudget: work.probes,
                raysPerProbe: plan.raysPerProbe,
                frameIndex,
                tileOffset: work.offset,
                tileBudget: work.tiles,
                tileCount: captureSchedule.tiles,
                lightCount: this.#lightCount,
                atlasWidth: capture.width,
                cardResolution: plan.cardResolution,
                radiosity: field.radiosity,
                environment: profile.environment,
                hysteresis: irradianceFieldRelightHysteresis(
                  plan,
                  restartProbeHistory ? 0 : probesSinceDirect,
                ),
                maxDistance: profile.maxDistance,
                surfaceBias: 0.5 * plan.grid.spacing,
                depthClamp: irradianceFieldDepthClamp(plan),
                cardMargin: 0.5 * plan.grid.spacing,
                gather: [current.gatherWidth, current.gatherHeight, current.width, current.height],
                query: plan.querySettings,
                worldSource:
                  traversal === 'global-sdf'
                    ? { traversal, expected: canonicalScene.expected }
                    : { traversal },
                reflections:
                  reflections === undefined
                    ? [0, 0]
                    : [reflections.maxRoughnessToTrace, reflections.roughnessFadeLength],
              }),
            )
            .unwrap();
        },
        // Compose encodes before `writeFrame` opens this frame's attempt.
        markEncoded: (stage) => {
          if (stage === 'compose') composeEncoded = true;
          else canonicalEncoded = canonicalScene.expected[3];
        },
        track: (completed) => {
          lifetime.track(completed);
          extent?.lifetime.track(completed);
          region.lifetime.track(completed);
          cards.track(completed);
          acceleration?.track(completed);
          if (attempt?.canonicalEpoch !== undefined)
            canonicalScene.submitted(attempt.canonicalEpoch);
          if (attempt?.composed) {
            region.composed = true;
            pendingBounds.length = 0;
          }
        },
        commit: () => {
          const settled = attempt;
          attempt = undefined;
          if (settled === undefined || fence.currentGeneration() !== fence.capturedGeneration)
            return;
          if (!cards.commit()) return;
          committedDirectionalPeak = settled.directionalPeak;
          cardWork = settled.work;
          probesSinceDirect =
            settled.restartProbeHistory && settled.work.relit > 0
              ? 0
              : probesSinceDirect + settled.probes.count;
          clipmap.commit(settled.probes);
          if (settled.radiosity !== undefined) cardRadiosity?.schedule.commit(settled.radiosity);
          acceleration?.commit();
          const slice = settled.slice;
          if (slice !== undefined) {
            capture.commitReceiverCapture(slice);
            captureSchedule.commit(slice);
          } else if (settled.full) {
            litLights = settled.lights;
            spatialRelightPending = false;
            // Cards are current: sweep the edited probes at fast hysteresis.
            clipmap.activateEdits();
          } else {
            const tileCount = captureSchedule.tiles;
            tileOffset = (tileOffset + settled.work.radiated) % tileCount;
          }
          if (
            localMotionOnly &&
            !hasPendingEdits() &&
            captureSchedule.done &&
            !spatialRelightPending
          )
            localMotionOnly = false;
          frameIndex = (frameIndex + 1) >>> 0;
          historyIndex = 1 - historyIndex;
          if (this.#ready?.generation === fence.capturedGeneration) this.#submitted++;
        },
        retire: () => {
          retired = true;
          if (this.#receiverCache?.field === prepared) this.#receiverCache = undefined;
          lifetime.retire();
        },
      };
      return prepared;
    } catch (cause) {
      destroy();
      throw cause;
    }
  }

  disable(): void {
    this.#pendingAssets.clear();
    if (this.#input === undefined) return;
    this.#input.runtime.giBudget?.release(this);
    this.#generation++;
    this.#ready?.retire();
    this.#ready = undefined;
    this.#input = undefined;
    this.#key = '';
    this.#error = undefined;
    this.#submitted = 0;
  }

  dispose(): void {
    this.#disposed = true;
    this.disable();
  }
}
