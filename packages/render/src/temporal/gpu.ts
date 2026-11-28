import { type Mat4, mat4 } from '@forgeax/engine-math';
import type {
  BindGroupLayout,
  Buffer,
  RhiDevice,
  RhiQueue,
  Sampler,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import type { CloudTransportFormat } from '../cloud/reconstruction/history';
import { cloudHistoryExtent, cloudMode0DepthFormat } from '../cloud/reconstruction/history';
import type { DeviceScope } from '../device/device-scope';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { temporalAnalysisCapacity } from '../pipeline/render-extent';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { CameraSnapshot } from '../render-contract';
import { ssrColorExtent } from '../ssr/scene-color-input';
import { requireTsrCapabilities, usesTsrCompute } from '../tsr/capabilities';
import { TSR_ANALYSIS_FORMATS, TSR_PARAMS_BYTES } from '../tsr/layout';
import {
  abortResurrection,
  commitResurrection,
  type TsrResurrection,
  type TsrResurrectionSlot,
} from '../tsr/resurrection';

export const TEMPORAL_HISTORY_FORMATS = Object.freeze({
  color: 'rgba16float',
  temporal: 'rgba16float',
  stability: 'r8unorm',
  /** UE TSR flickering history: GCS luma, gradient, total variation, count. */
  flicker: 'rgba8unorm',
} as const);

/** UE `r.TSR.ShadingRejection.Flickering.Period` default (frames). */
export const TAA_FLICKER_PERIOD = 2;
/** UE `r.TSR.ShadingRejection.Flickering.FrameRateCap` default (Hz). */
export const TAA_FLICKER_FRAME_RATE_CAP = 60;
/** UE `r.TSR.ShadingRejection.Flickering.MaxParallaxVelocity` default (px at 1080p). */
export const TAA_FLICKER_MAX_PARALLAX_VELOCITY = 10;
/** UE `MinBlendFinal` in TSRShadingAnalysis.ush ComputeMoireError. */
export const TAA_FLICKER_MIN_BLEND = 0.05;

/**
 * Frame-rate dependent flickering terms (TemporalSuperResolution.cpp ~1929-1942, 3012-3014,
 * 2528-2529). `deltaSeconds` is zero when the frame time is unknown.
 */
export function flickerTerms(
  deltaSeconds: number,
  width: number,
): { invThreshold: number; invMaxParallax: number } {
  // AdjustToFrameRate: below FrameRateCap (60 Hz) the period shrinks so that a
  // slower frame rate does not stretch the tolerated flicker window.
  const refreshToCap = deltaSeconds > 0 ? deltaSeconds * TAA_FLICKER_FRAME_RATE_CAP : 1;
  const period = TAA_FLICKER_PERIOD / Math.max(refreshToCap, 1);
  return {
    invThreshold: 1 - (1 - TAA_FLICKER_MIN_BLEND) ** period,
    invMaxParallax: 1 / (refreshToCap * TAA_FLICKER_MAX_PARALLAX_VELOCITY * (width / 1920)),
  };
}

/** Uniform bytes of `TaaResolveParams` in taa-resolve.wgsl. */
export const TEMPORAL_PARAMS_BYTES = 48;

/** Cloud transport history shares the renderer temporal owner and ping-pong fence. */
export const CLOUD_HISTORY_FORMATS = Object.freeze({
  radiance: 'rgba16float',
  transmittance: 'rgba16float',
  depth: 'rgba32float',
} as const);

export interface TemporalSurface {
  readonly texture: Texture;
  readonly view: TextureView;
}

export interface TsrParamsScratch {
  readonly bytes: ArrayBuffer;
  readonly floats: Float32Array;
  readonly words: Uint32Array;
  readonly u8: Uint8Array;
  readonly matA: Mat4;
  readonly matB: Mat4;
  readonly matC: Mat4;
  readonly matD: Mat4;
  uploadedFrame: object | undefined;
  uploadedWidth: number;
  uploadedHeight: number;
}

export interface TsrGpuAnalysis {
  readonly width: number;
  readonly height: number;
  readonly guide: [TemporalSurface, TemporalSurface];
  readonly moire: [TemporalSurface, TemporalSurface];
  readonly resurrection: TsrResurrection;
  readonly paramsScratch: TsrParamsScratch;
  inputWidth: number;
  inputHeight: number;
  pendingInput: readonly [number, number] | undefined;
}

interface TemporalGpuStateBase {
  readonly algorithm: TemporalGpuMode;
  readonly tsr: TsrGpuAnalysis | undefined;
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  readonly childScope: DeviceScope;
  width: number;
  height: number;
  valid: boolean;
  readIndex: 0 | 1;
  pendingIndex: 0 | 1 | undefined;
  readonly color: [TemporalSurface, TemporalSurface];
  /** TAA only: TSR runs its own shading analysis and never reads this history. */
  readonly flicker: [TemporalSurface, TemporalSurface] | undefined;
  /** Whether this candidate owns the optional cloud transport history MRT. */
  readonly cloudHistoryEnabled: boolean;
  readonly cloudHistoryFormat: CloudTransportFormat;
  readonly cloudHistoryDepthFormat: CloudTransportFormat;
  /** Previous/current cloud radiance, transmittance and representative depth. */
  readonly cloudRadiance: [TemporalSurface, TemporalSurface] | undefined;
  readonly cloudTransmittance: [TemporalSurface, TemporalSurface] | undefined;
  readonly cloudDepth: [TemporalSurface, TemporalSurface] | undefined;
  bindGroupLayout: BindGroupLayout | undefined;
  sceneVelocityLayout?: BindGroupLayout | undefined;
  sampler: Sampler | undefined;
  temporalSampler: Sampler | undefined;
  paramsBuffer: Buffer | undefined;
  committed: boolean;
}

export type TemporalGpuMode = 'taa' | 'tsr' | 'scene-color';
export type TemporalGpuState = TemporalGpuStateBase &
  (
    | {
        readonly mode: 'taa' | 'tsr';
        readonly temporal: [TemporalSurface, TemporalSurface];
        readonly stability: [TemporalSurface, TemporalSurface];
      }
    | { readonly mode: 'scene-color'; readonly temporal?: never; readonly stability?: never }
  );

function createSurface(
  device: RhiDevice,
  childScope: DeviceScope,
  label: string,
  width: number,
  height: number,
  format: TextureFormat = TEMPORAL_HISTORY_FORMATS.color,
  storage = false,
  mipLevelCount = 1,
  copyDestination = false,
): TemporalSurface {
  const texture = device.createTexture({
    label,
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    textureBindingViewDimension: undefined,
    mipLevelCount,
    usage:
      GPU_TEXTURE_USAGE_COPY_SRC |
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING |
      (copyDestination ? GPU_TEXTURE_USAGE_COPY_DST : 0) |
      (storage ? GPU_TEXTURE_USAGE_STORAGE_BINDING : 0),
  });
  if (!texture.ok) throw texture.error;
  childScope._adopt('texture', texture.value, (value) => {
    device.destroyTexture(value);
  });
  const view = device.createTextureView(texture.value, {
    label: `${label}.view`,
    dimension: '2d',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!view.ok) throw view.error;
  return { texture: texture.value, view: view.value };
}

function createState(
  device: RhiDevice,
  scope: DeviceScope,
  width: number,
  height: number,
  cloudHistoryEnabled: boolean,
  cloudHistoryFormat: CloudTransportFormat,
  cloudHistoryDepthFormat: CloudTransportFormat,
  algorithm: TemporalGpuMode,
  guideWidth: number,
  guideHeight: number,
): TemporalGpuState {
  const childScope = scope.createChild(`${scope.owner}:temporal`);
  const cloudExtent = cloudHistoryExtent(width, height);
  try {
    const isTsr = algorithm === 'tsr';
    const storage = isTsr && usesTsrCompute(device.caps);
    const surface = (label: string, format: TextureFormat = TEMPORAL_HISTORY_FORMATS.color) =>
      createSurface(device, childScope, label, width, height, format, storage);
    const colorSize =
      algorithm === 'scene-color' ? ssrColorExtent({ width, height }) : { width, height };
    const colorSurface = (slot: string) =>
      createSurface(
        device,
        childScope,
        `${algorithm}-history-color-${slot}`,
        colorSize.width,
        colorSize.height,
        TEMPORAL_HISTORY_FORMATS.color,
        storage,
      );
    const analysisPair = (kind: 'guide' | 'moire'): [TemporalSurface, TemporalSurface] => [
      createSurface(
        device,
        childScope,
        `tsr-${kind}-a`,
        guideWidth,
        guideHeight,
        TSR_ANALYSIS_FORMATS[kind],
        storage,
      ),
      createSurface(
        device,
        childScope,
        `tsr-${kind}-b`,
        guideWidth,
        guideHeight,
        TSR_ANALYSIS_FORMATS[kind],
        storage,
      ),
    ];
    // Persistent snapshots only receive copies and are sampled; they never need storage usage.
    const resurrectionSlot = (slot: string): TsrResurrectionSlot => {
      const copy = (label: string, w: number, h: number, format: TextureFormat) =>
        createSurface(
          device,
          childScope,
          `tsr-resurrection-${label}-${slot}`,
          w,
          h,
          format,
          false,
          1,
          true,
        );
      return {
        guide: copy('guide', guideWidth, guideHeight, TSR_ANALYSIS_FORMATS.guide),
        color: copy('color', width, height, TEMPORAL_HISTORY_FORMATS.color),
        stability: copy('stability', width, height, 'rgba8unorm'),
        viewProjection: new Float32Array(16),
        storedAt: undefined,
        inputWidth: 0,
        inputHeight: 0,
      };
    };
    return {
      algorithm,
      tsr: isTsr
        ? (() => {
            const bytes = new ArrayBuffer(TSR_PARAMS_BYTES);
            return {
              width: guideWidth,
              height: guideHeight,
              guide: analysisPair('guide'),
              moire: analysisPair('moire'),
              resurrection: {
                slots: [resurrectionSlot('a'), resurrectionSlot('b')],
                frame: 0,
                pending: undefined,
              },
              paramsScratch: {
                bytes,
                floats: new Float32Array(bytes),
                words: new Uint32Array(bytes),
                u8: new Uint8Array(bytes),
                matA: mat4.create(),
                matB: mat4.create(),
                matC: mat4.create(),
                matD: mat4.create(),
                uploadedFrame: undefined,
                uploadedWidth: 0,
                uploadedHeight: 0,
              },
              inputWidth: 0,
              inputHeight: 0,
              pendingInput: undefined,
            };
          })()
        : undefined,
      device,
      scope,
      childScope,
      width,
      height,
      valid: false,
      readIndex: 0,
      pendingIndex: undefined,
      color: [colorSurface('a'), colorSurface('b')],
      ...(algorithm === 'scene-color'
        ? { mode: algorithm }
        : {
            mode: algorithm,
            temporal: [
              surface(`${algorithm}-history-temporal-a`, TEMPORAL_HISTORY_FORMATS.temporal),
              surface(`${algorithm}-history-temporal-b`, TEMPORAL_HISTORY_FORMATS.temporal),
            ],
            stability: [
              surface(
                `${algorithm}-history-stability-a`,
                isTsr ? 'rgba8unorm' : TEMPORAL_HISTORY_FORMATS.stability,
              ),
              surface(
                `${algorithm}-history-stability-b`,
                isTsr ? 'rgba8unorm' : TEMPORAL_HISTORY_FORMATS.stability,
              ),
            ],
          }),
      flicker:
        isTsr || algorithm === 'scene-color'
          ? undefined
          : [
              surface('taa-history-flicker-a', TEMPORAL_HISTORY_FORMATS.flicker),
              surface('taa-history-flicker-b', TEMPORAL_HISTORY_FORMATS.flicker),
            ],
      cloudHistoryEnabled,
      cloudHistoryFormat,
      cloudHistoryDepthFormat,
      cloudRadiance: cloudHistoryEnabled
        ? [
            createSurface(
              device,
              childScope,
              'cloud-history-radiance-a',
              cloudExtent.width,
              cloudExtent.height,
              cloudHistoryFormat,
            ),
            createSurface(
              device,
              childScope,
              'cloud-history-radiance-b',
              cloudExtent.width,
              cloudExtent.height,
              cloudHistoryFormat,
            ),
          ]
        : undefined,
      cloudTransmittance: cloudHistoryEnabled
        ? [
            createSurface(
              device,
              childScope,
              'cloud-history-transmittance-a',
              cloudExtent.width,
              cloudExtent.height,
              cloudHistoryFormat,
            ),
            createSurface(
              device,
              childScope,
              'cloud-history-transmittance-b',
              cloudExtent.width,
              cloudExtent.height,
              cloudHistoryFormat,
            ),
          ]
        : undefined,
      cloudDepth: cloudHistoryEnabled
        ? [
            createSurface(
              device,
              childScope,
              'cloud-history-depth-a',
              cloudExtent.width,
              cloudExtent.height,
              cloudHistoryDepthFormat,
            ),
            createSurface(
              device,
              childScope,
              'cloud-history-depth-b',
              cloudExtent.width,
              cloudExtent.height,
              cloudHistoryDepthFormat,
            ),
          ]
        : undefined,
      bindGroupLayout: undefined,
      sampler: undefined,
      temporalSampler: undefined,
      paramsBuffer: undefined,
      committed: false,
    };
  } catch (cause) {
    childScope.abandon();
    throw cause;
  }
}

export function getTemporalParamsBuffer(state: TemporalGpuState): Buffer {
  if (state.paramsBuffer !== undefined) return state.paramsBuffer;
  const created = state.device.createBuffer({
    label: `${state.algorithm}-resolve-params`,
    size: state.algorithm === 'tsr' ? TSR_PARAMS_BYTES : TEMPORAL_PARAMS_BYTES,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!created.ok) {
    if (!state.committed) state.childScope.abandon();
    throw created.error;
  }
  state.childScope._adopt('buffer', created.value, (value) => {
    state.device.destroyBuffer(value);
  });
  const written = state.device.queue.writeBuffer(
    created.value,
    0,
    new Uint8Array(state.algorithm === 'tsr' ? TSR_PARAMS_BYTES : TEMPORAL_PARAMS_BYTES),
  );
  if (!written.ok) {
    if (!state.committed) state.childScope.abandon();
    throw written.error;
  }
  state.paramsBuffer = created.value;
  return created.value;
}

export function getTemporalGpuState(
  frameState: RenderFrameState,
  device: RhiDevice,
  scope: DeviceScope,
  width: number,
  height: number,
  cloudHistoryRequested = false,
  camera?: CameraSnapshot,
  mode: TemporalGpuMode = camera?.antialias === 'tsr' ? 'tsr' : 'taa',
): TemporalGpuState {
  // Graph preparation publishes this demand before any imported target is
  // resolved. That makes the first TAA and cloud pass share one candidate,
  // while a plain TAA frame allocates only its six TAA surfaces.
  const wantsCloudHistory =
    cloudHistoryRequested ||
    frameState.pendingCloudHistoryActive === true ||
    frameState.cloudHistoryActive === true;
  const algorithm = mode;
  if (algorithm === 'tsr') requireTsrCapabilities(device);
  const upper = temporalAnalysisCapacity(width, height, camera?.dynamicResolution?.maxScale);
  const cloudHistoryFormat =
    frameState.pendingCloudHistoryActive === true
      ? (frameState.pendingCloudHistoryFormat ?? CLOUD_HISTORY_FORMATS.radiance)
      : (frameState.cloudHistoryFormat ?? CLOUD_HISTORY_FORMATS.radiance);
  const cloudHistoryDepthFormat = cloudMode0DepthFormat(frameState.cameraStandardProfile);
  const matches = (state: TemporalGpuState | undefined): state is TemporalGpuState =>
    state !== undefined &&
    state.scope === scope &&
    state.algorithm === algorithm &&
    (state.tsr === undefined ||
      (state.tsr.width === upper.width && state.tsr.height === upper.height)) &&
    state.width === width &&
    state.height === height &&
    state.mode === mode &&
    // Cloud history is a demand-shaped part of the temporal allocation. Keep
    // the two shapes distinct so turning CloudLayer off retires its six HDR
    // surfaces instead of retaining them on an otherwise TAA-only frame.
    state.cloudHistoryEnabled === wantsCloudHistory &&
    (!wantsCloudHistory ||
      (state.cloudHistoryFormat === cloudHistoryFormat &&
        state.cloudHistoryDepthFormat === cloudHistoryDepthFormat));
  const staged = frameState.temporalGpuState;
  if (matches(staged)) return staged;
  const existing = frameState.activeTemporalGpuState;
  if (matches(existing)) return existing;
  const next = createState(
    device,
    scope,
    width,
    height,
    wantsCloudHistory,
    cloudHistoryFormat,
    cloudHistoryDepthFormat,
    algorithm,
    upper.width,
    upper.height,
  );
  frameState.temporalGpuState = next;
  return next;
}

export function getTemporalBindGroupResources(
  state: TemporalGpuState,
  sceneVelocity = false,
): {
  readonly layout: BindGroupLayout;
  readonly sampler: Sampler | null;
  readonly temporalSampler: Sampler | null;
} {
  const existingLayout = sceneVelocity ? state.sceneVelocityLayout : state.bindGroupLayout;
  if (existingLayout !== undefined) {
    return {
      layout: existingLayout,
      sampler: state.sampler ?? null,
      temporalSampler: state.temporalSampler ?? null,
    };
  }
  try {
    const layout = state.device.createBindGroupLayout({
      label: 'taa-resolve-bind-group',
      entries: [
        {
          binding: 0,
          visibility: 2,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
        {
          binding: 2,
          visibility: 2,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        { binding: 3, visibility: 2, sampler: { type: 'filtering' } },
        {
          binding: 4,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        { binding: 5, visibility: 2, sampler: { type: 'non-filtering' } },
        {
          binding: 6,
          visibility: 2,
          texture: {
            sampleType: sceneVelocity ? 'uint' : 'unfilterable-float',
            viewDimension: '2d',
          },
        },
        { binding: 7, visibility: 2, sampler: { type: 'non-filtering' } },
        { binding: 8, visibility: 2, buffer: { type: 'uniform' } },
        { binding: 9, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
        {
          binding: 10,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 11,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 12,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        { binding: 13, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
        ...(sceneVelocity
          ? [
              {
                binding: 14,
                visibility: 2,
                texture: { sampleType: 'depth' as const, viewDimension: '2d' as const },
              },
              { binding: 15, visibility: 2, buffer: { type: 'uniform' as const } },
            ]
          : []),
      ],
    });
    if (!layout.ok) throw layout.error;
    state.childScope._adopt('binding', layout.value, () => undefined);
    const sampler = state.device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    if (!sampler.ok) throw sampler.error;
    state.childScope._adopt('binding', sampler.value, () => undefined);
    const temporalSampler = state.device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'nearest',
      minFilter: 'nearest',
    });
    if (!temporalSampler.ok) throw temporalSampler.error;
    state.childScope._adopt('binding', temporalSampler.value, () => undefined);
    if (sceneVelocity) state.sceneVelocityLayout = layout.value;
    else state.bindGroupLayout = layout.value;
    state.sampler = sampler.value;
    state.temporalSampler = temporalSampler.value;
    return { layout: layout.value, sampler: sampler.value, temporalSampler: temporalSampler.value };
  } catch (cause) {
    if (!state.committed) {
      state.childScope.abandon();
      state.bindGroupLayout = undefined;
      state.sceneVelocityLayout = undefined;
      state.sampler = undefined;
      state.temporalSampler = undefined;
    }
    throw cause;
  }
}

export function temporalReadIndex(state: TemporalGpuState): 0 | 1 {
  return state.readIndex;
}

export function temporalWriteIndex(state: TemporalGpuState): 0 | 1 {
  return state.readIndex === 0 ? 1 : 0;
}

export function stageTemporalGpuSubmit(state: TemporalGpuState): void {
  state.pendingIndex = state.readIndex === 0 ? 1 : 0;
}

export function hasPendingTemporalGpuSubmit(state: TemporalGpuState): boolean {
  return state.pendingIndex !== undefined;
}

export function commitTemporalGpuSubmit(state: TemporalGpuState): boolean {
  if (state.pendingIndex === undefined) return false;
  if (state.tsr?.pendingInput !== undefined) {
    [state.tsr.inputWidth, state.tsr.inputHeight] = state.tsr.pendingInput;
    state.tsr.pendingInput = undefined;
  }
  if (state.tsr !== undefined) commitResurrection(state.tsr.resurrection);
  state.readIndex = state.pendingIndex;
  state.pendingIndex = undefined;
  state.valid = true;
  state.committed = true;
  return true;
}

function abortTemporalGpuSubmit(state: TemporalGpuState): void {
  if (state.tsr !== undefined) {
    state.tsr.pendingInput = undefined;
    abortResurrection(state.tsr.resurrection);
  }
  state.pendingIndex = undefined;
}

export function retireTemporalGpuState(state: TemporalGpuState): void {
  state.pendingIndex = undefined;
  state.childScope.retire();
  state.valid = false;
  state.committed = false;
  state.bindGroupLayout = undefined;
  state.sampler = undefined;
  state.temporalSampler = undefined;
  state.paramsBuffer = undefined;
}

export function retireTemporalGpuStateAfterFence(
  state: TemporalGpuState,
  queue: RhiQueue,
  retiring: Set<TemporalGpuState>,
  onFailure: (cause: unknown) => void,
): void {
  if (state.childScope.state === 'retired' || state.childScope.state === 'abandoned') return;
  state.childScope.beginRetire();
  retiring.add(state);
  void queue.onSubmittedWorkDone().then(
    () => {
      retiring.delete(state);
      retireTemporalGpuState(state);
    },
    (cause) => {
      retiring.delete(state);
      onFailure(cause);
      retireTemporalGpuState(state);
    },
  );
}

/*
 * Frame-level lifecycle of the TAA/CloudLayer ping-pong state. `temporalGpuState`
 * is the staged writer, `activeTemporalGpuState` the last accepted one, and
 * `retiringTemporalGpuStates` the generations waiting on their queue fence.
 */

/** Stage `state` as this frame's temporal history writer. */
export function stageTemporalGpuWrite(frameState: RenderFrameState, state: TemporalGpuState): void {
  stageTemporalGpuSubmit(state);
  frameState.temporalGpuState = state;
}

/** Promote the staged writer after an accepted submit; the replaced generation retires after its fence. */
export function commitStagedTemporalGpuState(
  frameState: RenderFrameState,
  queue: RhiQueue,
  hooks: { readonly onReplaced: () => void; readonly onRetireFailure: (cause: unknown) => void },
): void {
  const staged = frameState.temporalGpuState;
  if (staged === undefined || !commitTemporalGpuSubmit(staged)) return;
  const previous = frameState.activeTemporalGpuState;
  frameState.activeTemporalGpuState = staged;
  if (previous !== undefined && previous !== staged) {
    hooks.onReplaced();
    retireTemporalGpuStateAfterFence(
      previous,
      queue,
      frameState.retiringTemporalGpuStates,
      hooks.onRetireFailure,
    );
  }
  frameState.temporalGpuState = undefined;
}

/** Retire the accepted state after its fence once no temporal producer remains. */
export function retireActiveTemporalGpuState(
  frameState: RenderFrameState,
  queue: RhiQueue,
  onRetireFailure: (cause: unknown) => void,
): void {
  const active = frameState.activeTemporalGpuState;
  if (active === undefined) return;
  retireTemporalGpuStateAfterFence(
    active,
    queue,
    frameState.retiringTemporalGpuStates,
    onRetireFailure,
  );
  frameState.activeTemporalGpuState = undefined;
}

/** Drop the staged write of a failed frame; an unaccepted fresh allocation retires now. */
export function abortStagedTemporalGpuState(frameState: RenderFrameState): void {
  const staged = frameState.temporalGpuState;
  if (staged === undefined) return;
  abortTemporalGpuSubmit(staged);
  if (staged !== frameState.activeTemporalGpuState) retireTemporalGpuState(staged);
  frameState.temporalGpuState = undefined;
}

/** Retire every temporal generation immediately at disposal or device recovery. */
export function releaseTemporalGpuStates(frameState: RenderFrameState): void {
  if (frameState.temporalGpuState !== undefined) {
    retireTemporalGpuState(frameState.temporalGpuState);
    frameState.temporalGpuState = undefined;
  }
  if (frameState.activeTemporalGpuState !== undefined) {
    retireTemporalGpuState(frameState.activeTemporalGpuState);
    frameState.activeTemporalGpuState = undefined;
  }
  for (const retiring of frameState.retiringTemporalGpuStates) retireTemporalGpuState(retiring);
  frameState.retiringTemporalGpuStates.clear();
}
