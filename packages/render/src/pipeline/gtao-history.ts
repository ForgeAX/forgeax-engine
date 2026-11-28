import { type Mat4, mat4 } from '@forgeax/engine-math';
import type { GraphTextureView, RenderGraphError } from '@forgeax/engine-render-graph';
import type { RhiDevice, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { DepthPyramidExtent } from '../depth-pyramid/plan';
import type { DeviceScope } from '../device/device-scope';
import {
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineTarget } from '../render-pipeline';
import {
  type AmbientOcclusionSettings,
  GTAO_HISTORY_PARAMETER_COUNT,
  writeGtaoHistoryParameters,
} from '../ssao-config';
import { recordContext } from '../world/view-record-context';
import type { StandardPipelineBuildContext } from './standard-build-context';

const USAGE = GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING;

interface HistoryTexture {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly release: () => void;
}

class GtaoHistorySample {
  readonly matrix: Mat4 = mat4.create();
  readonly jitter: [number, number] = [0, 0];
  private readonly parameters = new Float64Array(GTAO_HISTORY_PARAMETER_COUNT);
  private entityKey: CameraSnapshot['entityKey'];
  private historyVersion: CameraSnapshot['historyVersion'];
  private projection: CameraSnapshot['projection'] | undefined;
  private near = 0;
  private far = 0;

  write(camera: CameraSnapshot, settings: AmbientOcclusionSettings | undefined): void {
    this.entityKey = camera.entityKey;
    this.historyVersion = camera.historyVersion;
    this.projection = camera.projection;
    this.near = camera.near;
    this.far = camera.far;
    this.jitter[0] = camera.temporal?.currentJitterUv?.[0] ?? 0;
    this.jitter[1] = camera.temporal?.currentJitterUv?.[1] ?? 0;
    writeGtaoHistoryParameters(this.parameters, settings);
  }

  matches(other: GtaoHistorySample): boolean {
    if (
      this.entityKey !== other.entityKey ||
      this.historyVersion !== other.historyVersion ||
      this.projection !== other.projection ||
      this.near !== other.near ||
      this.far !== other.far
    )
      return false;
    for (let i = 0; i < this.parameters.length; i++) {
      if (this.parameters[i] !== other.parameters[i]) return false;
    }
    return true;
  }
}

export class GtaoHistory {
  frameIndex = 0;
  used = false;
  recordedFrameCount = 0;
  private previous = 0 as 0 | 1;
  private readonly samples = [new GtaoHistorySample(), new GtaoHistorySample()] as const;

  constructor(
    readonly device: RhiDevice,
    readonly scope: DeviceScope,
    private readonly size: DepthPyramidExtent,
    readonly slots: readonly [HistoryTexture, HistoryTexture],
  ) {}

  matches(scope: DeviceScope, size: DepthPyramidExtent): boolean {
    return (
      this.scope === scope && this.size.width === size.width && this.size.height === size.height
    );
  }

  slot(write: boolean): HistoryTexture {
    return this.slots[write ? this.next : this.previous];
  }

  get pending(): GtaoHistorySample {
    return this.samples[this.next];
  }

  prepare(
    camera: CameraSnapshot,
    settings: AmbientOcclusionSettings | undefined,
  ): GtaoHistorySample | undefined {
    const pending = this.pending;
    pending.write(camera, settings);
    const previous = this.samples[this.previous];
    const valid = this.frameIndex !== 0 && previous.matches(pending);
    this.recordedFrameCount = valid ? this.frameIndex + 1 : 1;
    return valid ? previous : undefined;
  }

  accept(): void {
    this.previous = this.next;
    this.frameIndex = this.recordedFrameCount;
  }

  private get next(): 0 | 1 {
    return this.previous === 0 ? 1 : 0;
  }
}

function retireGtaoHistory(history: GtaoHistory | undefined): void {
  if (!history?.scope.isAlive()) return;
  const release = () => {
    for (const slot of history.slots) slot.release();
  };
  void history.device.queue.onSubmittedWorkDone().then(release, release);
}

export function disposeGtaoHistory(state: RenderFrameState): void {
  retireGtaoHistory(state.gtaoHistory);
  retireGtaoHistory(state.gtaoCandidateHistory);
  state.gtaoHistory = undefined;
  state.gtaoCandidateHistory = undefined;
}

export function beginGtaoHistory(state: RenderFrameState): void {
  if (state.gtaoHistory !== undefined) state.gtaoHistory.used = false;
  if (state.gtaoCandidateHistory !== undefined) state.gtaoCandidateHistory.used = false;
}

function recordedHistory(state: RenderFrameState): GtaoHistory | undefined {
  if (state.gtaoCandidateHistory?.used) return state.gtaoCandidateHistory;
  return state.gtaoHistory?.used ? state.gtaoHistory : undefined;
}

export function recordedGtaoHistoryLength(state: RenderFrameState): number | undefined {
  return recordedHistory(state)?.recordedFrameCount;
}

export function acceptGtaoHistory(state: RenderFrameState): void {
  const candidate = state.gtaoCandidateHistory;
  const history = recordedHistory(state);
  if (history === undefined) {
    disposeGtaoHistory(state);
    return;
  }
  if (candidate !== undefined) {
    retireGtaoHistory(history === candidate ? state.gtaoHistory : candidate);
    state.gtaoHistory = history;
    state.gtaoCandidateHistory = undefined;
  }
  history.accept();
}

function createHistoryTexture(
  scope: DeviceScope,
  device: RhiDevice,
  size: DepthPyramidExtent,
  index: number,
) {
  const label = `gtao-history-${index}`;
  const owner = scope
    .allocate(
      'texture',
      () =>
        device.createTexture({
          label,
          format: 'r8unorm',
          size: { ...size, depthOrArrayLayers: 1 },
          usage: USAGE,
        }),
      (texture) => device.destroyTexture(texture),
    )
    .unwrap();
  const texture = owner.reference.value;
  const view = device.createTextureView(texture, { label: `${label}.view`, dimension: '2d' });
  if (!view.ok) {
    owner.release().unwrap();
    throw view.error;
  }
  return {
    texture,
    view: view.value,
    release: () => {
      owner.release().unwrap();
    },
  };
}

export interface GtaoHistoryGraphInput {
  readonly previous: GraphTextureView;
  readonly output: RenderPipelineTarget;
  readonly resolve: (frame: _InternalRenderPipelineContext) => GtaoHistory;
}

export function importGtaoHistory(
  { graph }: StandardPipelineBuildContext,
  size: DepthPyramidExtent,
): Result<GtaoHistoryGraphInput, RenderGraphError> {
  function resolve(frame: _InternalRenderPipelineContext): GtaoHistory {
    const { frameState } = frame;
    const scope = recordContext(frame.runtime).deviceScope;
    const accepted = frameState.gtaoHistory;
    if (accepted?.matches(scope, size)) return accepted;
    let history = frameState.gtaoCandidateHistory;
    if (!history?.matches(scope, size)) {
      retireGtaoHistory(history);
      frameState.gtaoCandidateHistory = undefined;
      const device = frame.runtime.device;
      const first = createHistoryTexture(scope, device, size, 0);
      let second: HistoryTexture;
      try {
        second = createHistoryTexture(scope, device, size, 1);
      } catch (error) {
        first.release();
        throw error;
      }
      history = new GtaoHistory(device, scope, size, [first, second]);
      frameState.gtaoCandidateHistory = history;
    }
    return history;
  }

  function importSlot(
    name: string,
    write: boolean,
  ): Result<RenderPipelineTarget, RenderGraphError> {
    const slot = (frame: import('../render-pipeline').RenderPipelineFrame) =>
      resolve(frame as _InternalRenderPipelineContext).slot(write);
    const texture = graph.importTexture(
      name,
      { format: 'r8unorm', size, usage: USAGE },
      (frame) => slot(frame).texture,
    );
    if (!texture.ok) return texture;
    const view = graph.importView(
      texture.value,
      { label: `${name}.view`, dimension: '2d' },
      (frame) => slot(frame).view,
    );
    return view.ok
      ? ok({ texture: texture.value, view: view.value, format: 'r8unorm', sampleCount: 1 })
      : view;
  }
  const previous = importSlot('gtao-history-previous', false);
  if (!previous.ok) return previous;
  const output = importSlot('gtao-history-current', true);
  return output.ok ? ok({ previous: previous.value.view, output: output.value, resolve }) : output;
}
