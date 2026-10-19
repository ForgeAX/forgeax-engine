import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import {
  type BindGroup,
  type Buffer,
  RhiError,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import type { RendererGenerationFence } from '../assembly/renderer-frame-transaction';
import { ResidencyLifetime } from '../device/residency-lifetime';
import type { StandardIrradianceFieldGi } from '../pipeline/standard-profile';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import type { LightSnapshot } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { CardAtlasCapture, CardCaptureSlice } from './card-capture-schedule';
import { CardResidency, type CardResidencyInspection } from './card-residency';
import { createRayDiffuseComposite } from './diffuse-composite';
import {
  adoptFieldEdit,
  diffFieldEdit,
  type FieldEdit,
  type FieldSourceSlots,
  fieldEditState,
  fieldInputsUnchanged,
  fieldOutsideEmpty,
  fieldSourceSlots,
} from './field-edit';
import { globalSdfEditBox, packGlobalSdfEditBox } from './global-sdf';
import { createGlobalSdfTexture, GLOBAL_SDF_TEXTURE_WGSL } from './global-sdf-texture';
import {
  createIrradianceFieldKernel,
  createIrradianceFieldViewKernels,
  IRRADIANCE_FIELD_FRAME_BYTES,
  IRRADIANCE_FIELD_LIGHTS_BYTES,
  IRRADIANCE_FIELD_ORIGIN_BYTES,
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
import { writeFieldEdit } from './irradiance-field-edit';
import {
  IRRADIANCE_FIELD_DEPTH_BYTES,
  IRRADIANCE_FIELD_META_BYTES,
  IRRADIANCE_FIELD_PROBE_BYTES,
  IRRADIANCE_FIELD_RELIGHT_SWEEPS,
  type IrradianceFieldPlan,
  irradianceFieldRadiosityPeriod,
  irradianceFieldRelightHysteresis,
  planIrradianceField,
} from './irradiance-field-plan';
import { packLights } from './path-input';
import {
  type ProbeClipmapInspection,
  ProbeClipmapScheduler,
  type ProbeFrameSchedule,
} from './probe-clipmap';
import { createRayReflectionComposite } from './reflections-composite';
import type { ProbeCardCapture } from './renderer-probe-cards';
import { type ProbeGlobalRegion, prepareProbeGlobalRegion } from './renderer-probe-global';
import {
  type PreparedWorldAcceleration,
  prepareWorldAcceleration,
  selectWorldTraversal,
  WORLD_ACCELERATION_TRIANGLE_HEADROOM,
  type WorldAccelerationEdit,
  type WorldAccelerationInspection,
  type WorldTraversalFallback,
  worldAccelerationGeometries,
} from './renderer-world-acceleration';
import { projectSceneFields } from './scene-field-projection';
import type { WorldTraversal } from './world-traversal';

type Kernel = Extract<ReturnType<typeof createIrradianceFieldKernel>, { ok: true }>['value'];
type ViewKernels = Extract<
  ReturnType<typeof createIrradianceFieldViewKernels>,
  { ok: true }
>['value']['kernels'];

interface IrradianceFieldFrameInput {
  readonly runtime: RenderSystemInternals;
  readonly scene: PersistentGpuDrivenState;
  readonly worlds: readonly RenderResourceScope[];
  readonly leases: readonly RenderReadLease[] | undefined;
  readonly lights: readonly LightSnapshot[];
  readonly profile: StandardIrradianceFieldGi;
  /** View extent for the per-pixel gather and Lite reflections. */
  readonly width: number;
  readonly height: number;
  /** False when another lane (Screen Probes) owns the diffuse view gather. */
  readonly gatherView: boolean;
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
   * automatically: `'ray-query'` when `caps.rayQuery` is supported and the
   * projected scene fits its limits, else `'global-sdf'` with the closed reason.
   */
  readonly traversal?: WorldTraversal;
  readonly traversalFallback?: WorldTraversalFallback;
  /** The `'ray-query'` lane's TLAS residency. */
  readonly acceleration?: WorldAccelerationInspection;
  /** In-place scene edits applied to this generation (moves/removals of field sources). */
  readonly edits?: IrradianceFieldEditStats;
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
}

/** Per-extent view buffers; replaced on resize and retired only after their submissions. */
export interface IrradianceFieldExtent {
  readonly width: number;
  readonly height: number;
  readonly gatherWidth: number;
  readonly gatherHeight: number;
  /** Present only when this field gathers the view. */
  readonly gathered: Buffer | undefined;
  readonly upsampled: Buffer | undefined;
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
  readonly region: ProbeGlobalRegion;
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
  readonly kernels: Readonly<Record<IrradianceFieldKernelStage, Kernel>>;
  readonly view: ViewKernels;
  readonly sample: BindGroup;
  readonly visibility: ReturnType<typeof createGlobalSdfTexture>;
  readonly composite: Extract<ReturnType<typeof createRayDiffuseComposite>, { ok: true }>['value'];
  readonly reflectionComposite: Extract<
    ReturnType<typeof createRayReflectionComposite>,
    { ok: true }
  >['value'];
  /** Region composition is one-shot; it flips after a physical submit. */
  readonly composeRequired: () => boolean;
  /** Card capture is progressive: at most `cards.budget` tiles per submitted frame. */
  readonly capture: () => CardAtlasCapture;
  readonly capturedTiles: () => number;
  /** The last submitted frame's Card work, in tiles. */
  readonly cardWork: () => { readonly relit: number; readonly radiated: number };
  recordCapture(pass: RhiRenderPassEncoder): void;
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
  /** Scene revision this field reflects; in-place edits advance it. */
  revision: number;
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
  /** Field source slots as of {@link revision}. */
  sourceSlots: FieldSourceSlots;
  editStats(): Omit<IrradianceFieldEditStats, 'skippedProjections'>;
  extent(): IrradianceFieldExtent;
  /** Upload this attempt's schedule/lights. Failed submits do not advance offsets. */
  writeFrame(): void;
  markEncoded(stage: 'compose'): void;
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
  #error: RhiError | undefined;
  #disposed = false;
  #submitted = 0;
  #skippedProjections = 0;
  #lights: Uint8Array = new Uint8Array(IRRADIANCE_FIELD_LIGHTS_BYTES);
  #lightCount = 0;

  get ready(): PreparedIrradianceField | undefined {
    const ready = this.#ready;
    return ready?.fence.currentGeneration() === ready?.generation ? ready : undefined;
  }

  inspect(): IrradianceFieldInspection {
    const ready = this.ready;
    return {
      gather: 'irradiance-field',
      state: this.#error ? 'failed' : ready ? 'ready' : 'preparing',
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
            edits: { ...ready.editStats(), skippedProjections: this.#skippedProjections },
            ...(ready.residency === undefined ? {} : { residency: ready.residency.inspect() }),
            share: { views: this.#input?.runtime.giBudget?.views ?? 1, ...ready.share() },
          }),
      ...(this.#error === undefined
        ? {}
        : {
            error: {
              code: this.#error.code,
              expected: this.#error.expected,
              hint: this.#error.hint,
              detail: this.#error.detail,
            },
          }),
    };
  }

  #signature(): string {
    const input = this.#input;
    if (input === undefined) return '';
    return JSON.stringify([
      input.runtime.deviceScope.generation,
      // Scene content edits are diffed against the field rows (`#sync`), not keyed.
      input.runtime.assets.catalogEpoch,
      input.runtime.gpuStore.materialResourceEpoch,
      input.worlds.map((world) => world.identity),
      // Field identity only: the gather lane consuming the field never resets it.
      input.profile.maxDistance,
      input.profile.environment,
      input.profile.field,
    ]);
  }

  prepare(input: IrradianceFieldFrameInput): void {
    if (this.#disposed) return;
    const sceneChanged = this.#input?.scene.scene !== input.scene.scene;
    this.#input = input;
    let key: string;
    try {
      key = this.#signature();
      const lights = packLights(input.lights).unwrap();
      this.#lights = new Uint8Array(IRRADIANCE_FIELD_LIGHTS_BYTES);
      this.#lights.set(lights.subarray(0, Math.min(lights.byteLength, this.#lights.byteLength)));
      this.#lightCount = input.lights.length;
    } catch (cause) {
      this.#fail(input.runtime, cause);
      return;
    }
    const ready = this.#ready;
    if (sceneChanged || key !== this.#key || (ready !== undefined && !this.#sync(ready, input))) {
      this.#generation++;
      this.#key = key;
      this.#ready?.retire();
      this.#ready = undefined;
      this.#error = undefined;
      this.#submitted = 0;
      this.#skippedProjections = 0;
    }
    const current = this.ready;
    if (current !== undefined) {
      const budget = input.runtime.giBudget;
      budget?.claim(this, input.runtime.rendererFrameNumber ?? 0, input.focus);
      current.allocate(
        (total) => budget?.share(this, total) ?? total,
        budget?.focuses() ?? [input.focus],
      );
    }
    if (this.#pending || this.#ready || this.#error) return;
    this.#pending = true;
    const generation = this.#generation;
    let cards: ProbeCardCapture | undefined;
    const fence: RendererGenerationFence = {
      capturedGeneration: generation,
      currentGeneration: () => {
        if (this.#disposed || this.#generation !== generation) return -1;
        try {
          return this.#signature() === this.#key && cards?.current() !== false ? generation : -1;
        } catch {
          return -1;
        }
      },
    };
    void this.#build(input, fence, (value) => {
      cards = value;
    })
      .then(
        (candidate) => {
          const input = this.#input;
          if (
            fence.currentGeneration() === generation &&
            input !== undefined &&
            this.#sync(candidate, input)
          )
            this.#ready = candidate;
          else candidate.retire();
        },
        (cause) => {
          if (fence.currentGeneration() === generation) this.#fail(input.runtime, cause);
        },
      )
      .finally(() => {
        this.#pending = false;
      });
  }

  /** Bring a prepared field to the current scene revision by an in-place edit. */
  #sync(field: PreparedIrradianceField, input: IrradianceFieldFrameInput): boolean {
    const revision = input.scene.scene.contentRevision;
    if (field.revision === revision) return true;
    const retained = input.scene.retained;
    if (retained === undefined || !retained.isCurrent()) return false;
    if (
      fieldInputsUnchanged(
        field.sourceSlots,
        input.scene.scene.changedSlotsSince(field.revision),
        input.scene.slotAt,
        (records) => {
          const projected = projectSceneFields(
            records,
            input.worlds,
            input.profile.field.region,
            input.runtime.assets,
          );
          return !projected.ok || projected.value.sources.length > 0;
        },
      )
    ) {
      field.revision = revision;
      this.#skippedProjections++;
      return true;
    }
    const projected = projectSceneFields(
      retained.slots,
      input.worlds,
      input.profile.field.region,
      input.runtime.assets,
    );
    if (!projected.ok) return false;
    const edit = diffFieldEdit(field.editState, projected.value.sources, projected.value.instances);
    const applied = field.edit(edit);
    if (applied === 'rebuild') return false;
    if (applied === 'applied') {
      field.revision = revision;
      field.sourceSlots = fieldSourceSlots(projected.value.sources);
    }
    return true;
  }

  #fail(runtime: RenderSystemInternals, cause: unknown): void {
    this.#ready?.retire();
    this.#ready = undefined;
    this.#error =
      cause instanceof RhiError
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
    runtime.errorRegistry.fire(this.#error);
  }

  async #build(
    input: IrradianceFieldFrameInput,
    fence: RendererGenerationFence,
    publishCards: (cards: ProbeCardCapture) => void,
  ): Promise<PreparedIrradianceField> {
    const { runtime, profile } = input;
    const revision = input.scene.scene.contentRevision;
    const device = runtime.device;
    const shaders = runtime.shaderRegistry;
    const compile = runtime.createShaderModule;
    if (shaders === undefined || compile === undefined)
      throw new Error('irradiance-field GI requires the ordinary shader registry and compiler');
    const plan = planIrradianceField(profile.field).unwrap();
    const entries = [...shaders.entries()];
    const source = (entryPoint: string): string => {
      const matched = entries.filter((entry) => entry.wgsl.includes(`fn ${entryPoint}(`));
      const entry = matched[0];
      if (matched.length !== 1 || entry === undefined)
        throw new Error(`expected one published ${entryPoint} kernel`);
      return entry.wgsl;
    };
    const viewSource = source('gatherField');
    const compositeSource = source('fs_ray_diffuse');
    const reflectionSource = source('fs_ray_reflection_field');
    const field = profile.field;
    const region = await prepareProbeGlobalRegion(
      runtime,
      { scene: input.scene, worlds: input.worlds, leases: input.leases },
      {
        ...field.region,
        rayResolution: 1,
        tMax: profile.maxDistance,
        cards: field.cards,
      },
      true,
      input.focus,
    );
    const owned: Buffer[] = [];
    let extent: IrradianceFieldExtent | undefined;
    let acceleration: PreparedWorldAcceleration | undefined;
    let visibility: ReturnType<typeof createGlobalSdfTexture> | undefined;
    const destroy = () => {
      for (const buffer of owned) device.destroyBuffer(buffer);
      if (visibility !== undefined) device.destroyTexture(visibility.texture);
      acceleration?.dispose();
      region.lifetime.retire();
    };
    try {
      visibility = createGlobalSdfTexture(
        device,
        (
          await compile(device, {
            code: GLOBAL_SDF_TEXTURE_WGSL,
            label: 'irradiance-field.visibility',
          })
        ).unwrap(),
        region,
      );
      const cards = region.cards;
      if (cards === undefined) throw new Error('irradiance field requires native Card capture');
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
      for (const value of Object.values(buffers))
        if (value.size > limit)
          throw new Error(
            `irradiance field buffer of ${value.size} bytes exceeds the storage binding limit`,
          );
      const clipmap = new ProbeClipmapScheduler(plan, input.focus);
      device.queue
        .writeBuffer(buffers.field.buffer, 0, packIrradianceFieldUniform(plan, clipmap.windows()))
        .unwrap();
      this.#key = this.#signature();
      const geometries = worldAccelerationGeometries(region);
      const selection = selectWorldTraversal(
        device.caps.rayQuery,
        region.instances.length,
        geometries,
      );
      const traversal = selection.traversal;
      if (traversal === 'ray-query')
        acceleration = prepareWorldAcceleration(
          device,
          region,
          geometries,
          region.headroom === undefined
            ? undefined
            : {
                instances: region.headroom.rows.capacity,
                triangles: WORLD_ACCELERATION_TRIANGLE_HEADROOM,
              },
        ).unwrap();
      const sources = irradianceFieldKernelWgsl(traversal);
      const stages = Object.keys(sources) as IrradianceFieldKernelStage[];
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
        (async () =>
          (
            await compile(device, {
              label: 'irradiance-field.reflection-composite',
              code: reflectionSource,
            })
          ).unwrap())(),
      ]);
      const kernels = Object.fromEntries(
        stages.map((stage, i) => {
          const module = modules[i];
          if (module === undefined) throw new Error(`missing ${stage} module`);
          return [stage, createIrradianceFieldKernel(device, stage, module, traversal).unwrap()];
        }),
      ) as Record<IrradianceFieldKernelStage, Kernel>;
      const viewModule = modules[stages.length];
      const compositeModule = modules[stages.length + 1];
      const reflectionModule = modules[stages.length + 2];
      if (
        viewModule === undefined ||
        compositeModule === undefined ||
        reflectionModule === undefined
      )
        throw new Error('missing irradiance field view modules');
      const view = createIrradianceFieldViewKernels(device, viewModule, 'live').unwrap();
      const sample = device
        .createBindGroup({
          layout: view.sampleLayout,
          entries: [
            ...(['field', 'irradiance', 'moments', 'meta'] as const).map((name, binding) => ({
              binding,
              resource: { kind: 'buffer' as const, value: buffers[name] },
            })),
            { binding: 4, resource: { kind: 'buffer', value: region.input.settings } },
            { binding: 5, resource: { kind: 'textureView', value: visibility.view } },
          ],
        })
        .unwrap();
      const composite = createRayDiffuseComposite(
        device,
        compositeModule,
        'reconstructed',
      ).unwrap();
      const reflectionComposite = createRayReflectionComposite(
        device,
        reflectionModule,
        'field',
      ).unwrap();
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
      const residency =
        capture.residency === undefined
          ? undefined
          : new CardResidency(device, cards, editState, region.sources, region.instances);
      // This frame's Card relight rotation, the field's share of `plan.cardBudget`.
      let relight = plan.cardBudget;
      // Capture records before the frame upload; the upload adopts its slice.
      let encodedCapture: CardCaptureSlice | undefined;
      let composeEncoded = false;
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
      // Probe updates since Card direct light last changed (capture, light change
      // or edit); probe history and radiosity share its bounded settling sweeps.
      let probesSinceDirect = 0;
      let cardWork = { relit: 0, radiated: 0 };
      let attempt:
        | {
            lights: Uint8Array;
            full: boolean;
            work: { relit: number; radiated: number };
            slice: CardCaptureSlice | undefined;
            probes: ProbeFrameSchedule;
            composed: boolean;
          }
        | undefined;
      const pendingBounds: Parameters<typeof globalSdfEditBox>[1][number][] = [];
      let admitting = false;
      let admissionFailed = false;
      const full = () =>
        litLights === undefined ||
        litLights.byteLength !== this.#lights.byteLength ||
        litLights.some((value, i) => value !== this.#lights[i]);
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
        const reflections = current.profile.reflections !== undefined;
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
      return {
        generation: fence.capturedGeneration,
        fence,
        plan,
        region,
        visibility,
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
        kernels,
        view: view.kernels,
        sample,
        composite,
        reflectionComposite,
        composeRequired: () => !region.composed,
        capture: () => captureSchedule.mode(),
        capturedTiles: () => captureSchedule.captured,
        cardWork: () => cardWork,
        recordCapture: (pass) => {
          const slice = captureSchedule.slice();
          if (slice === undefined) return;
          if (slice.clear) cards.capture.clearTiles(pass, slice).unwrap();
          cards.capture.recordPass(pass, slice).unwrap();
          encodedCapture = slice;
        },
        schedule,
        composeDispatch: () => composeDispatch,
        revision,
        editState,
        residency,
        allocate: (share, focuses) => {
          clipmap.limit = share(plan.probeBudget);
          captureSchedule.limit = share(captureSchedule.budget);
          relight = share(plan.cardBudget);
          residency?.stream(focuses, captureSchedule, captureSchedule.limit);
        },
        share: () => ({
          probes: clipmap.limit,
          captureTiles: captureSchedule.limit,
          relightTiles: Math.min(relight, captureSchedule.tiles),
        }),
        sourceSlots: fieldSourceSlots(region.sources),
        editStats: () => ({
          ...edits,
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
          let written: ReturnType<typeof writeFieldEdit>;
          try {
            written = writeFieldEdit(device, region, cards, edit);
          } catch {
            return 'rebuild';
          }
          // Ray Query: moves rebuild only the TLAS, adds build a BLAS per new mesh, materials none.
          if (acceleration !== undefined) {
            const added: WorldAccelerationEdit['added'][number][] = [];
            for (const [i, add] of edit.added.entries()) {
              const row = written.added[i];
              const geometryId = region.headroom?.geometryIds.get(add.source.mesh);
              const positions = add.source.mesh.attributes.position;
              if (row === undefined || geometryId === undefined) return 'rebuild';
              if (!(positions instanceof Float32Array)) return 'rebuild';
              added.push({
                instance: {
                  instanceId: row,
                  geometryId,
                  mask: add.instance.mask,
                  transform: add.instance.transform,
                },
                geometry: { geometryId, positions, indices: add.source.mesh.indices },
              });
            }
            if (!acceleration.edit({ moved: edit.moved, removed: edit.removed, added }).ok)
              return 'rebuild';
          }
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
              box === undefined ? region.voxelCount : box.extent[0] * box.extent[1] * box.extent[2];
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
          litLights = undefined;
          edits.applied++;
          edits.movedInstances += edit.moved.length;
          edits.removedInstances += edit.removed.length;
          edits.addedInstances += edit.added.length;
          edits.rematerializedInstances += edit.rematerialized.length;
          edits.recapturedTiles += queued + fresh;
          edits.composedVoxels = written.bounds.length > 0 ? composeDispatch : 0;
          edits.priorityProbes = clipmap.priorityProbes();
          return 'applied';
        },
        extent: resize,
        writeFrame: () => {
          const current = resize();
          const work = schedule();
          const probes = probeSchedule();
          const reflections = (this.#input ?? input).profile.reflections;
          const relightAll = captureSchedule.slice() === undefined && full();
          attempt = {
            lights: this.#lights,
            full: relightAll,
            work: { relit: work.direct ? work.tiles : 0, radiated: work.tiles },
            slice: encodedCapture,
            probes,
            composed: composeEncoded,
          };
          encodedCapture = undefined;
          composeEncoded = false;
          const fieldUniform = packIrradianceFieldUniform(plan, clipmap.windows());
          // This frame's adopted scene bounds prove whether segment portions
          // outside the stored SDF box contain no geometry; never infer from voxels.
          new Uint32Array(fieldUniform.buffer)[15] = Number(
            fieldOutsideEmpty(editState, region.grid),
          );
          device.queue.writeBuffer(buffers.lights.buffer, 0, this.#lights).unwrap();
          device.queue
            .writeBuffer(buffers.probeList.buffer, 0, probes.list.subarray(0, probes.count))
            .unwrap();
          device.queue.writeBuffer(buffers.field.buffer, 0, fieldUniform).unwrap();
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
                  work.direct ? 0 : probesSinceDirect,
                ),
                maxDistance: profile.maxDistance,
                surfaceBias: 0.5 * plan.grid.spacing,
                depthClamp: irradianceFieldDepthClamp(plan),
                cardMargin: 0.5 * plan.grid.spacing,
                gather: [current.gatherWidth, current.gatherHeight, current.width, current.height],
                query: plan.querySettings,
                reflections:
                  reflections === undefined
                    ? [0, 0]
                    : [reflections.maxRoughnessToTrace, reflections.roughnessFadeLength],
              }),
            )
            .unwrap();
        },
        // Compose encodes before `writeFrame` opens this frame's attempt.
        markEncoded: () => {
          composeEncoded = true;
        },
        track: (completed) => {
          lifetime.track(completed);
          extent?.lifetime.track(completed);
          region.lifetime.track(completed);
          cards.track(completed);
          acceleration?.track(completed);
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
          cards.commit();
          cardWork = settled.work;
          probesSinceDirect = settled.work.relit > 0 ? 0 : probesSinceDirect + settled.probes.count;
          clipmap.commit(settled.probes);
          acceleration?.commit();
          const slice = settled.slice;
          if (slice !== undefined) captureSchedule.commit(slice);
          else if (settled.full) {
            litLights = settled.lights;
            // Cards are current: sweep the edited probes at fast hysteresis.
            clipmap.activateEdits();
          } else {
            const tileCount = captureSchedule.tiles;
            tileOffset = (tileOffset + settled.work.radiated) % tileCount;
          }
          frameIndex = (frameIndex + 1) >>> 0;
          historyIndex = 1 - historyIndex;
          if (this.#ready?.generation === fence.capturedGeneration) this.#submitted++;
        },
        retire: () => lifetime.retire(),
      };
    } catch (cause) {
      destroy();
      throw cause;
    }
  }

  disable(): void {
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
