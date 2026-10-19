import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import type { RendererGenerationFence } from '../assembly/renderer-frame-transaction';
import { ResidencyLifetime } from '../device/residency-lifetime';
import type { StandardScreenProbeGi } from '../pipeline/standard-profile';
import type { RenderSystemInternals } from '../record/render-context';
import type {
  IrradianceFieldInspection,
  PreparedIrradianceField,
} from './renderer-irradiance-field';
import {
  createScreenProbeKernels,
  createScreenProbeWorldKernel,
  type ScreenProbeKernel,
  type ScreenProbeStage,
  screenProbeWorldWgsl,
} from './screen-probe-kernels';
import {
  packScreenProbeFrame,
  planScreenProbeLayout,
  SCREEN_PROBE_ADAPTIVE_SLOTS,
  SCREEN_PROBE_FRAME_BYTES,
  SCREEN_PROBE_HISTORY_BYTES,
  SCREEN_PROBE_META_BYTES,
  SCREEN_PROBE_RADIANCE_BYTES,
  SCREEN_PROBE_RECORD_BYTES,
  SCREEN_PROBE_TEXELS,
  type ScreenProbeLayout,
  type ScreenProbeReprojection,
} from './screen-probe-plan';
import type { WorldTraversal } from './world-traversal';

/** Bytes of one probe ray record (direction/info, radiance and implicit alignment padding). */
const RAY_BYTES = 32;
const storage = 128 | 12;

interface ScreenProbeFrameInput {
  readonly runtime: RenderSystemInternals;
  readonly profile: StandardScreenProbeGi;
  /** The Renderer's shared Irradiance Field, prepared for this profile's `field`. */
  readonly field: PreparedIrradianceField | undefined;
  readonly width: number;
  readonly height: number;
}

export interface ScreenProbeInspection {
  readonly gather: 'screen-probe';
  readonly state: 'preparing' | 'ready' | 'failed';
  readonly generation: number;
  readonly submittedFrames: number;
  readonly pixelCount: number;
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
  readonly layout: ScreenProbeLayout;
  readonly buffers: Readonly<
    Record<BufferSlot, { readonly buffer: Buffer; readonly size: number }>
  >;
  readonly lifetime: ResidencyLifetime;
}

export interface PreparedScreenProbe {
  readonly generation: number;
  readonly fence: RendererGenerationFence;
  readonly field: PreparedIrradianceField;
  readonly profile: StandardScreenProbeGi;
  readonly kernels: Readonly<Record<ScreenProbeStage, ScreenProbeKernel>>;
  readonly world: ScreenProbeKernel;
  readonly frame: { readonly buffer: Buffer; readonly size: number };
  extent(): ScreenProbeExtent;
  /** History parity: 0 reads A and writes B; 1 the reverse. */
  parity(): 0 | 1;
  /** Set the last accepted view geometry this attempt reprojects history through. */
  reproject(previous: ScreenProbeReprojection | undefined): void;
  /** Upload this attempt's frame uniform; failed submits keep history flags. */
  writeFrame(): void;
  track(completed: Promise<unknown>): void;
  commit(): void;
  retire(): void;
}

interface Pipelines {
  readonly device: unknown;
  /** The field's world traversal the world-trace kernel composes. */
  readonly traversal: WorldTraversal;
  readonly kernels: Readonly<Record<ScreenProbeStage, ScreenProbeKernel>>;
  readonly world: ScreenProbeKernel;
}

/** Renderer-owned Screen Probe gather (Lumen-Lite step 6). It consumes the
 * Renderer's shared Irradiance Field as its world fallback and Card-radiance
 * producer; probe and pixel history reset on extent, field generation and
 * profile identity, and probe/pixel history restarts while an in-place field edit
 * is in flight. */
export class RendererScreenProbe {
  #input: ScreenProbeFrameInput | undefined;
  #key = '';
  #generation = 0;
  #pipelines: Pipelines | undefined;
  #pending = false;
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
    const key = JSON.stringify([
      input.runtime.deviceScope.generation,
      profile.probes,
      profile.maxDistance,
      profile.environment,
      field?.generation,
    ]);
    if (key !== this.#key) {
      this.#generation++;
      this.#key = key;
      this.#ready?.retire();
      this.#ready = undefined;
      this.#error = undefined;
      this.#submitted = 0;
    }
    if (
      this.#pipelines !== undefined &&
      (this.#pipelines.device !== input.runtime.device ||
        (field !== undefined && this.#pipelines.traversal !== field.traversal))
    )
      this.#pipelines = undefined;
    if (this.#error !== undefined || this.#ready !== undefined || field === undefined) return;
    if (this.#pipelines === undefined) {
      if (!this.#pending) this.#compile(input, field.traversal);
      return;
    }
    try {
      this.#ready = this.#assemble(input, this.#pipelines, field);
    } catch (cause) {
      this.#fail(input.runtime, cause);
    }
  }

  #compile(input: ScreenProbeFrameInput, traversal: WorldTraversal): void {
    const { runtime } = input;
    const device = runtime.device;
    const generation = this.#generation;
    this.#pending = true;
    void (async (): Promise<Pipelines> => {
      const shaders = runtime.shaderRegistry;
      const compile = runtime.createShaderModule;
      if (shaders === undefined || compile === undefined)
        throw new Error('screen-probe GI requires the ordinary shader registry and compiler');
      const matched = [...shaders.entries()].filter((entry) =>
        entry.wgsl.includes('fn integrateScreenProbes('),
      );
      const entry = matched[0];
      if (matched.length !== 1 || entry === undefined)
        throw new Error('expected one published screen-probe module');
      const [module, worldModule] = await Promise.all([
        (async () =>
          (await compile(device, { label: 'screen-probe', code: entry.wgsl })).unwrap())(),
        (async () =>
          (
            await compile(device, {
              label: 'screen-probe.world',
              code: screenProbeWorldWgsl(traversal),
            })
          ).unwrap())(),
      ]);
      const created = createScreenProbeKernels(device, module).unwrap();
      const world = createScreenProbeWorldKernel(device, worldModule, traversal).unwrap();
      return {
        device,
        traversal,
        kernels: created.kernels,
        world,
      };
    })()
      .then(
        (pipelines) => {
          if (
            !this.#disposed &&
            runtime.device === this.#input?.runtime.device &&
            traversal === this.#input.field?.traversal
          )
            this.#pipelines = pipelines;
        },
        (cause) => {
          if (!this.#disposed && this.#generation === generation) this.#fail(runtime, cause);
        },
      )
      .finally(() => {
        this.#pending = false;
      });
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
    const frame = device
      .createBuffer({ label: 'screen-probe.frame', size: SCREEN_PROBE_FRAME_BYTES, usage: 64 | 8 })
      .unwrap();
    owned.push(frame);
    const limit = device.limits.maxStorageBufferBindingSize;
    let extent: ScreenProbeExtent | undefined;
    let parity: 0 | 1 = 0;
    let history = false;
    let reprojection: ScreenProbeReprojection | undefined;
    let frameIndex = 0;
    let attempt: { readonly extent: ScreenProbeExtent } | undefined;
    const resize = (): ScreenProbeExtent => {
      const width = this.#input?.width ?? input.width;
      const height = this.#input?.height ?? input.height;
      if (extent !== undefined && extent.layout.width === width && extent.layout.height === height)
        return extent;
      const layout = planScreenProbeLayout(profile.probes, width, height);
      const pixels = width * height;
      const texels = layout.probeCount * SCREEN_PROBE_TEXELS;
      const sizes: Record<BufferSlot, number> = {
        probes: layout.probeCount * SCREEN_PROBE_RECORD_BYTES,
        adaptiveCount: Math.max(
          16,
          (1 + Math.ceil((layout.uniformCount * SCREEN_PROBE_ADAPTIVE_SLOTS) / 64)) * 4,
        ),
        tileAdaptive: layout.uniformCount * SCREEN_PROBE_ADAPTIVE_SLOTS * 4,
        rays: texels * RAY_BYTES,
        radianceA: texels * SCREEN_PROBE_RADIANCE_BYTES,
        radianceB: texels * SCREEN_PROBE_RADIANCE_BYTES,
        probeHistoryA: layout.probeCount * SCREEN_PROBE_HISTORY_BYTES,
        probeHistoryB: layout.probeCount * SCREEN_PROBE_HISTORY_BYTES,
        integrated: pixels * 16,
        historyA: pixels * 16,
        historyB: pixels * 16,
        metaA: pixels * SCREEN_PROBE_META_BYTES,
        metaB: pixels * SCREEN_PROBE_META_BYTES,
        previousScene: pixels * 8,
      };
      for (const [slot, size] of Object.entries(sizes))
        if (size > limit)
          throw new Error(
            `screen-probe ${slot} of ${size} bytes exceeds the storage binding limit ${limit}`,
          );
      const created: Buffer[] = [];
      const buffers = Object.fromEntries(
        (Object.keys(sizes) as BufferSlot[]).map((slot) => {
          const size = sizes[slot];
          const buffer = device
            .createBuffer({ label: `screen-probe.${slot}`, size, usage: storage })
            .unwrap();
          created.push(buffer);
          return [slot, { buffer, size }];
        }),
      ) as Record<BufferSlot, { buffer: Buffer; size: number }>;
      extent?.lifetime.retire();
      extent = {
        layout,
        buffers,
        lifetime: new ResidencyLifetime(() => {
          for (const buffer of created) device.destroyBuffer(buffer);
        }),
      };
      history = false;
      parity = 0;
      return extent;
    };
    resize();
    const lifetime = new ResidencyLifetime(() => {
      extent?.lifetime.retire();
      for (const buffer of owned) device.destroyBuffer(buffer);
    });
    const spacing = field.plan.grid.spacing;
    return {
      generation,
      fence,
      field,
      profile,
      kernels: pipelines.kernels,
      world: pipelines.world,
      frame: { buffer: frame, size: SCREEN_PROBE_FRAME_BYTES },
      extent: resize,
      parity: () => parity,
      reproject: (previous) => {
        reprojection = previous;
      },
      writeFrame: () => {
        const current = resize();
        attempt = { extent: current };
        // An in-place field edit changes world lighting discontinuously: probe/pixel
        // history restarts until its Cards and probe sweeps settle, as a rebuild would.
        const edits = field.editStats();
        const editing = edits.pendingTiles + edits.pendingPriorityUpdates > 0;
        device.queue
          .writeBuffer(
            frame,
            0,
            packScreenProbeFrame({
              layout: current.layout,
              downsample: profile.probes.downsample,
              frameIndex,
              importance: profile.probes.importance,
              screenSteps: profile.probes.screenTrace.maxSteps,
              thickness: profile.probes.screenTrace.thickness,
              environment: profile.environment,
              maxDistance: profile.maxDistance,
              shortRangeAo: profile.probes.shortRangeAo,
              maxFrames: profile.probes.maxFrames,
              sceneHistory: history && profile.probes.history?.screen !== false,
              pixelHistory: history && !editing && profile.probes.history?.pixel !== false,
              probeHistory: history && !editing && profile.probes.history?.probe !== false,
              worldBias: spacing,
              cardMargin: 0.5 * spacing,
              query: field.plan.querySettings,
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
  }

  dispose(): void {
    this.#disposed = true;
    this.disable();
  }
}
