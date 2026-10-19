import {
  addObservationCapturePass,
  addTypedOutputTransformPass,
  createStandardForwardPipeline,
  type RenderPipeline,
} from '@forgeax/engine-render/authoring';

/** Native Forward lighting and scene work, with Three's encoded attachment blending. */
export const threePipeline: RenderPipeline = createStandardForwardPipeline({
  format: 'rgba8unorm',
  domain: 'display-encoded',
  build(context, _topology, color, _depth, surface) {
    // The graph-owned resolved target remains copyable even on a raw-only canvas.
    if (context.observationCaptureDomains?.includes('final-display')) {
      const capture = addObservationCapturePass(context.graph, color, 'final-display');
      if (!capture.ok) return capture;
    }
    return addTypedOutputTransformPass(context.graph, color, surface.storage, {
      outputOnly: true,
      fragmentEntryPoint: 'fs_present',
      dither: false,
    });
  },
});
