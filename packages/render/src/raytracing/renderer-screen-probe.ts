import { type Buffer, RhiError, type Texture, type TextureView } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RendererGenerationFence } from '../assembly/renderer-frame-transaction';
import { ResidencyLifetime } from '../device/residency-lifetime';
import type { StandardScreenProbeGi } from '../pipeline/standard-profile';
import type { RenderSystemInternals } from '../record/render-context';
import { recordContext } from '../world/view-record-context';
import { type FieldReceiverFrame, unavailableFieldReceivers } from './field-receiver';
import { findPublishedKernel } from './published-kernel';
import type {
  IrradianceFieldInspection,
  PreparedIrradianceField,
} from './renderer-irradiance-field';
import { createScreenProbeExtent } from './screen-probe-extent';
import {
  createScreenProbeKernels,
  createScreenProbeReceiverKernel,
  createScreenProbeRootKernel,
  createScreenProbeWorldKernel,
  type ScreenProbeKernel,
  type ScreenProbeKernels,
  type ScreenProbeTracePath,
  screenProbeWorldWgsl,
} from './screen-probe-kernels';
import {
  packScreenProbeFrame,
  planScreenProbeLayout,
  SCREEN_PROBE_FRAME_BYTES,
  SCREEN_PROBE_TEXELS,
  type ScreenProbeLayout,
  type ScreenProbeReprojection,
  screenProbeAllocationSizes,
} from './screen-probe-plan';
import { screenProbeReceiverWgsl } from './screen-probe-receiver';
import {
  type screenProbeReceiverDescriptor,
  screenProbeReceiverSource,
  uploadScreenProbeReceiverSource,
} from './screen-probe-receiver-source';
import { screenProbeRootPrepareWgsl, screenProbeRootRefineWgsl } from './screen-probe-root-kernels';
import {
  createScreenProbeScatterNoise,
  type ScreenProbeScatterNoise,
} from './screen-probe-scatter-noise';
import type { MeshDfApproxPolicy, WorldTraversal } from './world-traversal';

/** One explicit renderer model. Approximate completion is not an exact-hit tag.
 * The private selection is qualified before a production caller adopts it. */
export type ScreenSoftwareWorld =
  | { readonly kind: 'strict' }
  | { readonly kind: 'paid-root' }
  | { readonly kind: 'mesh-df'; readonly policy: MeshDfApproxPolicy };

function softwareWorldKey(mode: ScreenSoftwareWorld | undefined): string {
  if (mode?.kind !== 'mesh-df') return mode?.kind ?? 'strict';
  const { receiverBiasVoxels, expansionVoxels, maxErrorVoxels, nearDistance } = mode.policy;
  return JSON.stringify([
    'mesh-df',
    receiverBiasVoxels,
    expansionVoxels,
    maxErrorVoxels,
    nearDistance,
  ]);
}

interface ScreenProbeFrameInput {
  /** Same-frame material writer/graph dependency, not a receiver data credential. */
  readonly visibleSurface: boolean;
  /** Internal renderer-model selection; omission retains the strict reference. */
  readonly softwareWorld?: ScreenSoftwareWorld;
  /** Renderer reconstruction method; omission retains the strict reference path. */
  readonly reconstruction?: 'current-support';
  readonly runtime: RenderSystemInternals;
  readonly profile: StandardScreenProbeGi;
  /** The Renderer's shared Irradiance Field, prepared for this profile's `field`. */
  readonly field: PreparedIrradianceField | undefined;
  /** Current Field selection for pipeline demand only; never a data credential. */
  readonly plannedTraversal?: WorldTraversal | undefined;
  readonly plannedFarRadiance?: boolean | undefined;
  readonly width: number;
  readonly height: number;
}

export interface ScreenProbeInspection {
  readonly gather: 'screen-probe';
  readonly state: 'preparing' | 'ready' | 'failed';
  readonly generation: number;
  readonly submittedFrames: number;
  readonly pixelCount: number;
  /** Completion belongs to this model, not a canonical primitive certificate. */
  readonly softwareWorld?: ScreenSoftwareWorld;
  readonly probes?: {
    readonly downsample: number;
    readonly tiles: readonly [number, number];
    readonly uniform: number;
    readonly adaptiveCapacity: number;
    readonly raysPerProbe: number;
    readonly filterPasses: number;
  };
  /** The shared world-space fallback that also lights the Card radiance world rays read. */
  readonly field?: IrradianceFieldInspection;
  readonly error?: Pick<RhiError, 'code' | 'expected' | 'hint' | 'detail'>;
}

type BufferSlot =
  | 'probes'
  | 'adaptiveCount'
  | 'tileAdaptive'
  | 'rays'
  | 'radianceA'
  | 'radianceB'
  | 'integrated'
  | 'probeHistoryA'
  | 'probeHistoryB'
  | 'historyA'
  | 'historyB'
  | 'metaA'
  | 'metaB'
  | 'previousScene';

/** Per-extent buffers, replaced on resize and retired after their submissions. */
export interface ScreenProbeExtent {
  readonly receiverSource?: {
    readonly texture: Texture;
    readonly view: TextureView;
    readonly bytes: number;
    readonly descriptor: ReturnType<typeof screenProbeReceiverDescriptor>;
  };
  readonly rootRequests?: { readonly buffer: Buffer; readonly size: number };
  readonly previousScreenDepth?: { readonly buffer: Buffer; readonly size: number };
  readonly layout: ScreenProbeLayout;
  readonly buffers: Readonly<
    Record<BufferSlot, { readonly buffer: Buffer; readonly size: number }>
  >;
  readonly lifetime: ResidencyLifetime;
}

export interface PreparedScreenProbe {
  readonly pixelOwnedHistory: boolean;
  readonly receiver?: ScreenProbeKernel;
  readonly roots?: readonly [ScreenProbeKernel, ScreenProbeKernel];
  readonly generation: number;
  readonly fence: RendererGenerationFence;
  readonly field: PreparedIrradianceField;
  readonly receivers: Result<FieldReceiverFrame, RhiError>;
  readonly profile: StandardScreenProbeGi;
  readonly kernels: ScreenProbeKernels;
  readonly world: ScreenProbeKernel;
  readonly worldMotion?: ScreenProbeKernel;
  readonly scatterNoise?: ScreenProbeScatterNoise;
  readonly frame: { readonly buffer: Buffer; readonly size: number };
  extent(): ScreenProbeExtent;
  /** History parity: 0 reads A and writes B; 1 the reverse. */
  parity(): 0 | 1;
  /** Set the last accepted view geometry this attempt reprojects history through. */
  reproject(previous: ScreenProbeReprojection | undefined): void;
  /** Upload this attempt's frame uniform; failed submits keep history flags. */
  writeFrame(qualifiedLocalMotion?: boolean): void;
  track(completed: Promise<unknown>): void;
  commit(): void;
  retire(): void;
}

interface Pipelines {
  readonly receiver?: ScreenProbeKernel;
  readonly roots?: readonly [ScreenProbeKernel, ScreenProbeKernel];
  readonly device: unknown;
  /** The field's world traversal the world-trace kernel composes. */
  readonly traversal: WorldTraversal;
  readonly softwareWorld: string;
  readonly kernels: ScreenProbeKernels;
  readonly world: ScreenProbeKernel;
  readonly worldMotion?: ScreenProbeKernel;
}

interface PipelinePreparation {
  readonly device: RenderSystemInternals['device'];
  readonly scope: RenderSystemInternals['deviceScope'];
  readonly generation: number;
  readonly shaders: RenderSystemInternals['shaderRegistry'];
  readonly compile: RenderSystemInternals['createShaderModule'];
  /** Only prepare the irradiance PSOs when the profile selects that route. */
  readonly preintegrate: boolean;
  readonly screenSpace: boolean;
  readonly shortRangeAoMode: StandardScreenProbeGi['probes']['shortRangeAoMode'];
  readonly tracePath: ScreenProbeTracePath;
  kernels?: ScreenProbeKernels;
  world?: {
    readonly traversal: WorldTraversal;
    readonly split: boolean;
    readonly softwareWorld: string;
    ready?: Pick<
      Pipelines,
      'traversal' | 'world' | 'worldMotion' | 'roots' | 'receiver' | 'softwareWorld'
    >;
  };
}

/** Renderer-owned Screen Probe gather. It consumes the
 * Renderer's shared Irradiance Field as its world fallback and Card-radiance
 * producer; probe and pixel history reset on extent, field generation and
 * profile identity, and probe/pixel history restarts while an in-place field edit
 * is in flight. */
export class RendererScreenProbe {
  #input: ScreenProbeFrameInput | undefined;
  #key = '';
  #generation = 0;
  #pipelines: Pipelines | undefined;
  #preparation: PipelinePreparation | undefined;
  #error: RhiError | undefined;
  #ready: PreparedScreenProbe | undefined;
  #disposed = false;
  #submitted = 0;

  get ready(): PreparedScreenProbe | undefined {
    const ready = this.#ready;
    if (ready === undefined || ready.fence.currentGeneration() !== ready.generation)
      return undefined;
    return ready;
  }

  inspect(field: IrradianceFieldInspection | undefined): ScreenProbeInspection {
    const input = this.#input;
    const ready = this.ready;
    const layout = ready?.extent().layout;
    return {
      gather: 'screen-probe',
      state: this.#error || field?.state === 'failed' ? 'failed' : ready ? 'ready' : 'preparing',
      generation: this.#generation,
      submittedFrames: this.#submitted,
      pixelCount: input ? input.width * input.height : 0,
      ...((input?.field?.traversal ?? input?.plannedTraversal) === 'global-sdf'
        ? { softwareWorld: input?.softwareWorld ?? { kind: 'strict' as const } }
        : {}),
      ...(layout === undefined || input === undefined
        ? {}
        : {
            probes: {
              downsample: input.profile.probes.downsample,
              tiles: [layout.tilesX, layout.tilesY] as const,
              uniform: layout.uniformCount,
              adaptiveCapacity: layout.adaptiveCapacity,
              raysPerProbe: SCREEN_PROBE_TEXELS,
              filterPasses: input.profile.probes.filterPasses,
            },
          }),
      ...(field === undefined ? {} : { field }),
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

  prepare(input: ScreenProbeFrameInput): void {
    if (this.#disposed) return;
    this.#input = input;
    const { profile, field } = input;
    const traversal = field?.traversal ?? input.plannedTraversal;
    const preintegrate = profile.probes.irradiance !== undefined;
    const screenSpace = profile.probes.integration === 'screen-space';
    const shortRangeAoMode = profile.probes.shortRangeAoMode;
    let tracePath: ScreenProbeTracePath | undefined = 'dense';
    if (screenSpace && traversal === 'ray-query') {
      const farRadiance =
        field === undefined ? input.plannedFarRadiance === true : field.farRadiance !== undefined;
      tracePath = farRadiance ? 'far-radiance' : 'compacted';
    } else if (
      screenSpace &&
      traversal === undefined &&
      input.runtime.device.caps.rayQuery.supported
    ) {
      tracePath = undefined;
    }
    if (
      this.#preparation !== undefined &&
      (!this.#currentPreparation(this.#preparation) ||
        this.#preparation.preintegrate !== preintegrate ||
        this.#preparation.screenSpace !== screenSpace ||
        this.#preparation.shortRangeAoMode !== shortRangeAoMode ||
        (tracePath !== undefined && this.#preparation.tracePath !== tracePath))
    ) {
      this.#preparation = undefined;
      this.#pipelines = undefined;
      this.#key = '';
    }
    const key = JSON.stringify([
      recordContext(input.runtime).deviceScope.generation,
      profile.probes,
      profile.maxDistance,
      profile.environment,
      field?.generation,
      traversal,
      tracePath,
      softwareWorldKey(input.softwareWorld),
      input.reconstruction,
      input.visibleSurface,
    ]);
    if (key !== this.#key) {
      if (this.#error !== undefined) {
        this.#preparation = undefined;
        this.#pipelines = undefined;
      }
      this.#generation++;
      this.#key = key;
      this.#ready?.retire();
      this.#ready = undefined;
      this.#error = undefined;
      this.#submitted = 0;
    }
    if (input.softwareWorld?.kind === 'mesh-df' && input.reconstruction !== 'current-support') {
      if (this.#error === undefined)
        this.#fail(
          input.runtime,
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'current-support reconstruction for the approximate Mesh DF World model',
            hint: 'select current-support explicitly; strict reference reconstruction requires strict World evidence',
          }),
        );
      return;
    }
    if (preintegrate && input.reconstruction !== 'current-support') {
      if (this.#error === undefined)
        this.#fail(
          input.runtime,
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'current-support reconstruction for probe irradiance preintegration',
            hint: 'select current-support to retain the observed coverage of the probe irradiance',
          }),
        );
      return;
    }
    this.#invalidatePipelines(input, traversal);
    if (this.#error !== undefined || this.#ready !== undefined || tracePath === undefined) return;
    const preparation = this.#preparation ?? this.#compileScreen(input, tracePath);
    if (traversal === undefined) delete preparation.world;
    else this.#compileWorld(input, preparation, traversal);
    if (
      this.#pipelines === undefined ||
      field === undefined ||
      (field.traversal === 'global-sdf' && !input.visibleSurface)
    )
      return;
    try {
      this.#ready = this.#assemble(input, this.#pipelines, field);
    } catch (cause) {
      this.#fail(input.runtime, cause);
    }
  }

  #invalidatePipelines(input: ScreenProbeFrameInput, traversal: WorldTraversal | undefined): void {
    if (
      this.#pipelines !== undefined &&
      (this.#pipelines.device !== input.runtime.device ||
        this.#pipelines.softwareWorld !== softwareWorldKey(input.softwareWorld) ||
        (traversal !== undefined && this.#pipelines.traversal !== traversal))
    )
      this.#pipelines = undefined;
  }

  #currentPreparation(preparation: PipelinePreparation): boolean {
    const runtime = this.#input?.runtime;
    return (
      !this.#disposed &&
      this.#preparation === preparation &&
      runtime !== undefined &&
      runtime.device === preparation.device &&
      recordContext(runtime).deviceScope === preparation.scope &&
      preparation.scope.generation === preparation.generation &&
      runtime.shaderRegistry === preparation.shaders &&
      runtime.createShaderModule === preparation.compile
    );
  }

  #publishPipelines(preparation: PipelinePreparation): void {
    const input = this.#input;
    const world = preparation.world;
    if (
      !this.#currentPreparation(preparation) ||
      this.#error !== undefined ||
      preparation.kernels === undefined ||
      world?.ready === undefined ||
      input?.field?.traversal !== world.traversal ||
      world.softwareWorld !== softwareWorldKey(input.softwareWorld)
    )
      return;
    this.#pipelines = { device: preparation.device, kernels: preparation.kernels, ...world.ready };
  }

  #compileScreen(
    input: ScreenProbeFrameInput,
    tracePath: ScreenProbeTracePath,
  ): PipelinePreparation {
    const { runtime } = input;
    const device = runtime.device;
    const scope = recordContext(runtime).deviceScope;
    const preparation: PipelinePreparation = {
      device,
      scope,
      generation: scope.generation,
      shaders: runtime.shaderRegistry,
      compile: runtime.createShaderModule,
      preintegrate: input.profile.probes.irradiance !== undefined,
      screenSpace: input.profile.probes.integration === 'screen-space',
      shortRangeAoMode: input.profile.probes.shortRangeAoMode,
      tracePath,
    };
    this.#preparation = preparation;
    void (async () => {
      const { shaders, compile } = preparation;
      if (shaders === undefined || compile === undefined)
        throw new Error('screen-probe GI requires the ordinary shader registry and compiler');
      const entries = [...shaders.entries()];
      const source = findPublishedKernel(entries, 'integrateScreenProbes');
      const generate = findPublishedKernel(entries, 'generateCachedProbeRays');
      if (source === undefined || generate === undefined)
        throw new Error('expected one ordinary and one private Generate screen-probe module');
      const atlas =
        preparation.tracePath !== 'dense'
          ? findPublishedKernel(entries, 'lightTraceFallbacksAtlas')
          : undefined;
      const [screenModule, generateModule, atlasModule] = await Promise.all([
        compile(device, { label: 'screen-probe', code: source }),
        compile(device, { label: 'screen-probe.generate', code: generate }),
        atlas === undefined
          ? undefined
          : compile(device, { label: 'screen-probe.atlas', code: atlas }),
      ]);
      return (
        await createScreenProbeKernels(
          device,
          screenModule.unwrap(),
          generateModule.unwrap(),
          preparation.preintegrate,
          preparation.screenSpace,
          atlasModule?.unwrap(),
          preparation.shortRangeAoMode,
          preparation.tracePath,
        )
      ).unwrap();
    })().then(
      (created) => {
        if (!this.#currentPreparation(preparation)) return;
        preparation.kernels = created.kernels;
        this.#publishPipelines(preparation);
      },
      (cause) => {
        if (this.#currentPreparation(preparation) && this.#error === undefined)
          this.#fail(runtime, cause);
      },
    );
    return preparation;
  }

  #compileWorld(
    input: ScreenProbeFrameInput,
    preparation: PipelinePreparation,
    traversal: WorldTraversal,
  ): void {
    const { runtime } = input;
    const { device, compile } = preparation;
    const split = input.softwareWorld?.kind === 'paid-root';
    const compact = traversal === 'ray-query' && preparation.screenSpace;
    const softwareWorld = softwareWorldKey(input.softwareWorld);
    const approximate =
      input.softwareWorld?.kind === 'mesh-df' ? input.softwareWorld.policy : undefined;
    if (
      preparation.world?.traversal === traversal &&
      preparation.world.softwareWorld === softwareWorld
    ) {
      this.#publishPipelines(preparation);
      return;
    }
    const requested: NonNullable<PipelinePreparation['world']> = {
      traversal,
      split,
      softwareWorld,
    };
    preparation.world = requested;
    void (async () => {
      if (compile === undefined)
        throw new Error('screen-probe GI requires the ordinary shader registry and compiler');
      if ((split || approximate !== undefined) && traversal !== 'global-sdf')
        throw new Error('explicit software Screen models require software World');
      const [worldModule, receiverModule, rootModules] = await Promise.all([
        (async () =>
          (
            await compile(device, {
              label: 'screen-probe.world',
              code: screenProbeWorldWgsl(traversal, split, approximate, compact),
            })
          ).unwrap())(),
        traversal === 'global-sdf'
          ? (async () =>
              (
                await compile(device, {
                  label: 'screen-probe.receivers',
                  code: screenProbeReceiverWgsl(),
                })
              ).unwrap())()
          : undefined,
        Promise.all(
          split
            ? [screenProbeRootPrepareWgsl(), screenProbeRootRefineWgsl()].map(async (code, index) =>
                (await compile(device, { label: `screen-probe.root-${index}`, code })).unwrap(),
              )
            : [],
        ),
      ]);
      if (worldModule === undefined) throw new Error('missing Screen modules');
      // These PSOs consume modules, not one another. Drain all requests before
      // adopting the bundle, retaining World -> roots -> receiver error priority.
      const [world, rootPrepare, rootRefine, receiver, worldMotion] = (
        await Promise.allSettled([
          (async () =>
            (
              await (split
                ? createScreenProbeRootKernel(device, worldModule, 'resolveRoot')
                : createScreenProbeWorldKernel(
                    device,
                    worldModule,
                    traversal,
                    approximate === undefined,
                    compact,
                  ))
            ).unwrap())(),
          ...([0, 1] as const).map(async (index) => {
            const module = rootModules[index];
            return module === undefined
              ? undefined
              : (
                  await createScreenProbeRootKernel(
                    device,
                    module,
                    index === 0 ? 'prepareRoot' : 'refineRoot',
                  )
                ).unwrap();
          }),
          (async () =>
            receiverModule === undefined
              ? undefined
              : (await createScreenProbeReceiverKernel(device, receiverModule)).unwrap())(),
          (async () => {
            if (!compact) return undefined;
            const source = screenProbeWorldWgsl(traversal, false, undefined, true, true);
            const module = (
              await compile(device, { label: 'screen-probe.world-motion', code: source })
            ).unwrap();
            return (
              await createScreenProbeWorldKernel(device, module, traversal, true, true, true)
            ).unwrap();
          })(),
        ])
      ).map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      if (world === undefined) throw new Error('missing Screen World kernel');
      const roots =
        rootPrepare === undefined || rootRefine === undefined
          ? undefined
          : ([rootPrepare, rootRefine] as const);
      return {
        traversal,
        softwareWorld,
        world,
        ...(worldMotion === undefined ? {} : { worldMotion }),
        ...(receiver === undefined ? {} : { receiver }),
        ...(roots === undefined ? {} : { roots }),
      };
    })().then(
      (world) => {
        if (!this.#currentPreparation(preparation) || preparation.world !== requested) return;
        requested.ready = world;
        this.#publishPipelines(preparation);
      },
      (cause) => {
        if (
          this.#currentPreparation(preparation) &&
          preparation.world === requested &&
          this.#error === undefined
        )
          this.#fail(runtime, cause);
      },
    );
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
              'compute-capable WebGPU, the published screen-probe module and per-extent buffers within the storage binding limit',
            hint: 'inspect the screen-probe preparation cause; WebGL2 has no compute and must use a non-ray diffuse lane',
            detail: {
              error: {
                code: 'screen-probe-preparation',
                message: cause instanceof Error ? cause.message : JSON.stringify(cause),
                ...(typeof cause === 'object' && cause !== null ? { detail: cause } : {}),
              },
            },
          });
    runtime.errorRegistry.fire(this.#error);
  }

  #assemble(
    input: ScreenProbeFrameInput,
    pipelines: Pipelines,
    field: PreparedIrradianceField,
  ): PreparedScreenProbe {
    const device = input.runtime.device;
    const { profile } = input;
    const generation = this.#generation;
    const key = this.#key;
    const fence: RendererGenerationFence = {
      capturedGeneration: generation,
      currentGeneration: () =>
        !this.#disposed &&
        this.#generation === generation &&
        this.#key === key &&
        field.fence.currentGeneration() === field.generation
          ? generation
          : -1,
    };
    const owned: Buffer[] = [];
    const limit = device.limits.maxStorageBufferBindingSize;
    // The larger optional extent must be admissible before even allocating
    // this generation's frame buffer. Resize uses the same single ledger.
    if (pipelines.roots !== undefined)
      screenProbeAllocationSizes(
        planScreenProbeLayout(profile.probes, input.width, input.height),
        limit,
        true,
      );
    const frame = device
      .createBuffer({ label: 'screen-probe.frame', size: SCREEN_PROBE_FRAME_BYTES, usage: 64 | 8 })
      .unwrap();
    owned.push(frame);
    let extent: ScreenProbeExtent | undefined;
    let parity: 0 | 1 = 0;
    let history = false;
    let reprojection: ScreenProbeReprojection | undefined;
    let frameIndex = 0;
    let attempt: { readonly extent: ScreenProbeExtent } | undefined;
    const resize = (): ScreenProbeExtent => {
      const width = this.#input?.width ?? input.width;
      const height = this.#input?.height ?? input.height;
      const source =
        pipelines.receiver === undefined
          ? undefined
          : screenProbeReceiverSource(device, field, frameIndex);
      if (
        extent !== undefined &&
        extent.layout.width === width &&
        extent.layout.height === height &&
        (source === undefined ||
          (extent.receiverSource?.descriptor.size.width === source.width &&
            extent.receiverSource.descriptor.size.height === source.height))
      )
        return extent;
      const layout = planScreenProbeLayout(profile.probes, width, height);
      const replacement = createScreenProbeExtent(
        device,
        layout,
        pipelines.roots !== undefined,
        source,
        field.traversal === 'ray-query',
      );
      extent?.lifetime.retire();
      extent = replacement;
      history = false;
      parity = 0;
      return extent;
    };
    const usesTraceScatter = pipelines.kernels.scatterProbeTraces !== undefined;
    const noise =
      usesTraceScatter || pipelines.kernels.computeScreenProbeShortRangeAo !== undefined
        ? createScreenProbeScatterNoise(device)
        : ok(undefined);
    if (!noise.ok) {
      for (const buffer of owned) device.destroyBuffer(buffer);
      throw noise.error;
    }
    const lifetime = new ResidencyLifetime(() => {
      extent?.lifetime.retire();
      if (noise.value !== undefined) device.destroyTexture(noise.value.texture);
      for (const buffer of owned) device.destroyBuffer(buffer);
    });
    try {
      resize();
    } catch (error) {
      lifetime.retire();
      throw error;
    }
    // Lumen accumulates indirect lighting at the pixel. Retain the latest
    // directional probe sample for ray guiding and honor explicit overrides.
    const pixelOwnedHistory =
      usesTraceScatter &&
      profile.probes.history?.probe === undefined &&
      profile.probes.history?.pixel !== false;
    const spacing = field.plan.grid.spacing;
    const receiverFrame = (): Result<FieldReceiverFrame, RhiError> =>
      fence.currentGeneration() === generation && this.#input?.field === field
        ? field.receivers
        : ok(unavailableFieldReceivers('field-not-ready'));
    return {
      generation,
      fence,
      field,
      get receivers() {
        return receiverFrame();
      },
      profile,
      pixelOwnedHistory,
      kernels: pipelines.kernels,
      world: pipelines.world,
      ...(pipelines.worldMotion === undefined ? {} : { worldMotion: pipelines.worldMotion }),
      ...(noise.value === undefined ? {} : { scatterNoise: noise.value }),
      ...(pipelines.receiver === undefined ? {} : { receiver: pipelines.receiver }),
      ...(pipelines.roots === undefined ? {} : { roots: pipelines.roots }),
      frame: { buffer: frame, size: SCREEN_PROBE_FRAME_BYTES },
      extent: resize,
      parity: () => parity,
      reproject: (previous) => {
        reprojection = previous;
      },
      writeFrame: (qualifiedLocalMotion = false) => {
        const current = resize();
        if (current.receiverSource !== undefined) {
          const source = screenProbeReceiverSource(device, field, frameIndex);
          if (
            source.width !== current.receiverSource.descriptor.size.width ||
            source.height !== current.receiverSource.descriptor.size.height
          )
            throw new Error('receiver projection changed during the admitted Screen frame');
          uploadScreenProbeReceiverSource(device, current.receiverSource.texture, source).unwrap();
        }
        attempt = { extent: current };
        const fieldHistory = field.screenProbeHistory();
        // The actual Compact graph classifies hit motion and validates each
        // pixel donor. Legacy paths still wait for pending Field edits.
        const preservePixels =
          fieldHistory === 'stable' || (qualifiedLocalMotion && fieldHistory === 'local-motion');
        device.queue
          .writeBuffer(
            frame,
            0,
            packScreenProbeFrame({
              ...(input.reconstruction === undefined
                ? {}
                : { reconstruction: input.reconstruction }),
              layout: current.layout,
              downsample: profile.probes.downsample,
              frameIndex,
              importance: profile.probes.importance,
              stochasticInterpolation: profile.probes.interpolation === 'stochastic',
              sh3Irradiance: profile.probes.irradiance === 'probe-sh3',
              shortRangeAoMode: profile.probes.shortRangeAoMode,
              // Software hits are tagged proposals. The same canonical World
              // query verifies their endpoint and closest prefix before lighting.
              screenSteps: profile.probes.screenTrace.maxSteps,
              thickness: profile.probes.screenTrace.thickness,
              environment: profile.environment,
              maxDistance: profile.maxDistance,
              shortRangeAo: profile.probes.shortRangeAo,
              maxFrames: profile.probes.maxFrames,
              pixelOwnedHistory,
              sceneHistory: history && profile.probes.history?.screen !== false,
              pixelHistory: history && preservePixels && profile.probes.history?.pixel !== false,
              probeHistory:
                history && fieldHistory === 'stable' && profile.probes.history?.probe !== false,
              worldBias: spacing,
              cardMargin: 0.5 * spacing,
              query: field.plan.querySettings,
              receiverRevision: field.retained.revision,
              worldSource:
                field.traversal === 'global-sdf'
                  ? { traversal: field.traversal, expected: field.canonical.expected }
                  : { traversal: field.traversal },
              reprojection,
            }),
          )
          .unwrap();
      },
      track: (completed) => {
        lifetime.track(completed);
        extent?.lifetime.track(completed);
        field.track(completed);
      },
      commit: () => {
        const settled = attempt;
        attempt = undefined;
        field.commit();
        if (settled === undefined || fence.currentGeneration() !== generation) return;
        if (settled.extent !== extent) return;
        parity = parity === 0 ? 1 : 0;
        history = true;
        frameIndex = (frameIndex + 1) >>> 0;
        if (this.#ready?.generation === generation) this.#submitted++;
      },
      retire: () => lifetime.retire(),
    };
  }

  disable(): void {
    if (this.#input === undefined) return;
    this.#generation++;
    this.#ready?.retire();
    this.#ready = undefined;
    this.#input = undefined;
    this.#key = '';
    this.#error = undefined;
    this.#submitted = 0;
    if (this.#pipelines === undefined) this.#preparation = undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.disable();
    this.#preparation = undefined;
    this.#pipelines = undefined;
  }
}
