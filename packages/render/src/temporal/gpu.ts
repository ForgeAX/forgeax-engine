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
import { cloudHistoryExtent } from '../cloud/temporal';
import type { DeviceScope } from '../device/device-scope';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import type { RenderFrameState } from '../record/frame-snapshot';

export const TEMPORAL_HISTORY_FORMATS = Object.freeze({
  color: 'rgba16float',
  temporal: 'rgba16float',
  stability: 'r8unorm',
} as const);

/** Cloud transport history shares the renderer temporal owner and ping-pong fence. */
export const CLOUD_HISTORY_FORMATS = Object.freeze({
  radiance: 'rgba16float',
  transmittance: 'rgba16float',
  depth: 'rgba16float',
} as const);

interface TemporalSurface {
  readonly texture: Texture;
  readonly view: TextureView;
}

export interface TemporalGpuState {
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  readonly childScope: DeviceScope;
  width: number;
  height: number;
  valid: boolean;
  readIndex: 0 | 1;
  pendingIndex: 0 | 1 | undefined;
  readonly color: [TemporalSurface, TemporalSurface];
  readonly temporal: [TemporalSurface, TemporalSurface];
  readonly stability: [TemporalSurface, TemporalSurface];
  /** Whether this candidate owns the optional cloud transport history MRT. */
  readonly cloudHistoryEnabled: boolean;
  /** Previous/current cloud radiance, transmittance and representative depth. */
  readonly cloudRadiance: [TemporalSurface, TemporalSurface] | undefined;
  readonly cloudTransmittance: [TemporalSurface, TemporalSurface] | undefined;
  readonly cloudDepth: [TemporalSurface, TemporalSurface] | undefined;
  bindGroupLayout: BindGroupLayout | undefined;
  sampler: Sampler | undefined;
  temporalSampler: Sampler | undefined;
  paramsBuffer: Buffer | undefined;
  committed: boolean;
}

function createSurface(
  device: RhiDevice,
  childScope: DeviceScope,
  label: string,
  width: number,
  height: number,
  format: TextureFormat = TEMPORAL_HISTORY_FORMATS.color,
): TemporalSurface {
  const texture = device.createTexture({
    label,
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    textureBindingViewDimension: undefined,
    usage:
      GPU_TEXTURE_USAGE_COPY_SRC |
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING,
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
): TemporalGpuState {
  const childScope = scope.createChild(`${scope.owner}:temporal`);
  const cloudExtent = cloudHistoryExtent(width, height);
  try {
    return {
      device,
      scope,
      childScope,
      width,
      height,
      valid: false,
      readIndex: 0,
      pendingIndex: undefined,
      color: [
        createSurface(device, childScope, 'taa-history-color-a', width, height),
        createSurface(device, childScope, 'taa-history-color-b', width, height),
      ],
      temporal: [
        createSurface(
          device,
          childScope,
          'taa-history-temporal-a',
          width,
          height,
          TEMPORAL_HISTORY_FORMATS.temporal,
        ),
        createSurface(
          device,
          childScope,
          'taa-history-temporal-b',
          width,
          height,
          TEMPORAL_HISTORY_FORMATS.temporal,
        ),
      ],
      stability: [
        createSurface(
          device,
          childScope,
          'taa-history-stability-a',
          width,
          height,
          TEMPORAL_HISTORY_FORMATS.stability,
        ),
        createSurface(
          device,
          childScope,
          'taa-history-stability-b',
          width,
          height,
          TEMPORAL_HISTORY_FORMATS.stability,
        ),
      ],
      cloudHistoryEnabled,
      cloudRadiance: cloudHistoryEnabled
        ? [
            createSurface(
              device,
              childScope,
              'cloud-history-radiance-a',
              cloudExtent.width,
              cloudExtent.height,
            ),
            createSurface(
              device,
              childScope,
              'cloud-history-radiance-b',
              cloudExtent.width,
              cloudExtent.height,
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
              CLOUD_HISTORY_FORMATS.transmittance,
            ),
            createSurface(
              device,
              childScope,
              'cloud-history-transmittance-b',
              cloudExtent.width,
              cloudExtent.height,
              CLOUD_HISTORY_FORMATS.transmittance,
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
              CLOUD_HISTORY_FORMATS.depth,
            ),
            createSurface(
              device,
              childScope,
              'cloud-history-depth-b',
              cloudExtent.width,
              cloudExtent.height,
              CLOUD_HISTORY_FORMATS.depth,
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
    label: 'taa-resolve-params',
    size: 32,
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
  const written = state.device.queue.writeBuffer(created.value, 0, new Uint8Array(32));
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
): TemporalGpuState {
  // Graph preparation publishes this demand before any imported target is
  // resolved. That makes the first TAA and cloud pass share one candidate,
  // while a plain TAA frame allocates only its six TAA surfaces.
  const wantsCloudHistory =
    cloudHistoryRequested ||
    frameState.pendingCloudHistoryActive === true ||
    frameState.cloudHistoryActive === true;
  const matches = (state: TemporalGpuState | undefined): state is TemporalGpuState =>
    state !== undefined &&
    state.scope === scope &&
    state.width === width &&
    state.height === height &&
    // Cloud history is a demand-shaped part of the temporal allocation. Keep
    // the two shapes distinct so turning CloudLayer off retires its six HDR
    // surfaces instead of retaining them on an otherwise TAA-only frame.
    state.cloudHistoryEnabled === wantsCloudHistory;
  const staged = frameState.temporalGpuState;
  if (matches(staged)) return staged;
  const existing = frameState.activeTemporalGpuState;
  if (matches(existing)) return existing;
  const next = createState(device, scope, width, height, wantsCloudHistory);
  frameState.temporalGpuState = next;
  return next;
}

export function getTemporalBindGroupResources(state: TemporalGpuState): {
  readonly layout: BindGroupLayout;
  readonly sampler: Sampler | null;
  readonly temporalSampler: Sampler | null;
} {
  if (state.bindGroupLayout !== undefined) {
    return {
      layout: state.bindGroupLayout,
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
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
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
    state.bindGroupLayout = layout.value;
    state.sampler = sampler.value;
    state.temporalSampler = temporalSampler.value;
    return { layout: layout.value, sampler: sampler.value, temporalSampler: temporalSampler.value };
  } catch (cause) {
    if (!state.committed) {
      state.childScope.abandon();
      state.bindGroupLayout = undefined;
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
  state.readIndex = state.pendingIndex;
  state.pendingIndex = undefined;
  state.valid = true;
  state.committed = true;
  return true;
}

export function abortTemporalGpuSubmit(state: TemporalGpuState): void {
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
