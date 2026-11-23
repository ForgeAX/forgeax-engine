import type { Mat4 } from '@forgeax/engine-math';
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
import type { RenderPipelineTarget } from '../render-pipeline';
import { recordContext } from '../world/view-record-context';
import type { StandardPipelineBuildContext } from './standard-build-context';

const USAGE = GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING;

interface HistoryTexture {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly release: () => void;
}

interface GtaoHistorySample {
  readonly matrix: Mat4;
  readonly jitter: readonly [number, number];
}

export interface GtaoHistory {
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  readonly signature: string;
  readonly slots: readonly [HistoryTexture, HistoryTexture];
  previous: 0 | 1;
  accepted: GtaoHistorySample | undefined;
  pending: GtaoHistorySample | undefined;
  frameIndex: number;
  used: boolean;
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
  for (const history of [state.gtaoHistory, state.gtaoCandidateHistory]) {
    if (history === undefined) continue;
    history.pending = undefined;
    history.used = false;
  }
}

export function acceptGtaoHistory(state: RenderFrameState): void {
  const candidate = state.gtaoCandidateHistory;
  const history = candidate?.used ? candidate : state.gtaoHistory;
  if (!history?.used) {
    disposeGtaoHistory(state);
    return;
  }
  if (history.pending === undefined) return;
  if (history === candidate) {
    retireGtaoHistory(state.gtaoHistory);
    state.gtaoHistory = history;
    state.gtaoCandidateHistory = undefined;
  }
  history.accepted = history.pending;
  history.pending = undefined;
  history.previous = history.previous === 0 ? 1 : 0;
  history.frameIndex += 1;
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
  configurationKey: string,
): Result<GtaoHistoryGraphInput, RenderGraphError> {
  function resolve(frame: _InternalRenderPipelineContext): GtaoHistory {
    const { camera, frameState } = frame;
    const scope = recordContext(frame.runtime).deviceScope;
    const signature = JSON.stringify([
      camera.entityKey,
      camera.historyVersion,
      camera.projection,
      camera.near,
      camera.far,
      size.width,
      size.height,
      configurationKey,
    ]);
    const accepted = frameState.gtaoHistory;
    if (accepted?.scope === scope && accepted.signature === signature) return accepted;
    let history = frameState.gtaoCandidateHistory;
    if (history?.scope !== scope || history.signature !== signature) {
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
      history = {
        device,
        scope,
        signature,
        slots: [first, second],
        previous: 0,
        accepted: undefined,
        pending: undefined,
        frameIndex: 0,
        used: false,
      };
      frameState.gtaoCandidateHistory = history;
    }
    return history;
  }

  function importSlot(
    name: string,
    write: boolean,
  ): Result<RenderPipelineTarget, RenderGraphError> {
    const slot = (frame: import('../render-pipeline').RenderPipelineFrame) => {
      const history = resolve(frame as _InternalRenderPipelineContext);
      const previous = history.previous;
      return history.slots[write ? (previous === 0 ? 1 : 0) : previous];
    };
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
