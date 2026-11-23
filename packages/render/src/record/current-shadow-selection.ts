import type { RenderGraphBuilder, RenderGraphNativePass } from '@forgeax/engine-render-graph';
import type { TextureView } from '@forgeax/engine-rhi';
import type { GpuDrivenView } from '../gpu-driven/view-gpu';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { _InternalRenderPipelineContext } from './render-context';

/** Actual fitted splits belong to this recording, independently of the padded GPU matrix ABI. */
export function currentDirectionalShadowCount(frame: _InternalRenderPipelineContext): number {
  return Math.max(
    0,
    Math.min(
      4,
      frame.directionalDepthViews ?? frame.pipelineState.perPassResources.shadowCascadeCount,
    ),
  );
}

/** All selected light views have independent visible, skin and indirect storage. Each
 * dispatch uses its view bindings. The rasters consume those buffers on this encoder. */
export function addCurrentShadowSelection(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  directionalCount: number,
  useReceiverDepth: boolean,
  currentDirectional = false,
) {
  const views: GpuDrivenView[] = [];
  const readbacks: GpuDrivenView[] = [];
  let receiverDepth: TextureView | undefined;
  const selection: RenderGraphNativePass = {
    kind: 'compute',
    name: 'gpu-driven.shadow.view-selection',
    encode(pass) {
      for (const view of views) {
        if (view.hasSkinDemand) view.recordSkinDemand(pass);
        view.recordViewSelection(pass, false, receiverDepth);
      }
    },
  };
  const readback: RenderGraphNativePass = {
    kind: 'copy',
    name: 'gpu-driven.shadow.selection-readback',
    encode(encoder) {
      for (const view of readbacks) view.recordSelectionReadback(encoder, false);
    },
  };
  return graph.addSubgraphPass('shadow-view-selection', {
    accesses: [],
    profilePasses: () => [selection, readback],
    commandsDirect(frame, _resources, issue, recording) {
      const state = frame as _InternalRenderPipelineContext;
      try {
        state.gpuDrivenShadowViews?.collectSelectionViews(
          currentDirectional ? currentDirectionalShadowCount(state) : directionalCount,
          views,
          readbacks,
        );
        if (views.length === 0) return;
        receiverDepth = useReceiverDepth
          ? state.frameState.currentOcclusionDepth?.current
          : undefined;
        issue(recording, selection);
        if (readbacks.length > 0) issue(recording, readback);
      } finally {
        views.length = readbacks.length = 0;
        receiverDepth = undefined;
      }
    },
  });
}
