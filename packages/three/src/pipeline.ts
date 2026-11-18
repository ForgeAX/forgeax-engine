import {
  addObservationCapturePass,
  addTypedOutputTransformPass,
  createRenderPipelineTarget,
  createStandardForwardPipeline,
  type RenderPipeline,
} from '@forgeax/engine-render/authoring';

/** r187 WebGPU blends premultiplied linear color and encodes unassociated color once. */
export function createThreePipeline(
  format: 'rgba16float' | 'rgba8unorm' = 'rgba16float',
): RenderPipeline {
  return createStandardForwardPipeline({
    format,
    domain: 'linear-hdr',
    build(context, _topology, color, _depth, surface) {
      const output = createRenderPipelineTarget(context.graph, 'three-output', {
        format: 'rgba8unorm',
        size: 'surface',
        domain: 'display-encoded',
      });
      if (!output.ok) return output;
      const transformed = addTypedOutputTransformPass(context.graph, color, output.value, {
        dither: false,
        fragmentEntryPoint: 'fs_premultiplied',
      });
      if (!transformed.ok) return transformed;
      if (context.observationCaptureDomains?.includes('final-display')) {
        const capture = addObservationCapturePass(context.graph, output.value, 'final-display');
        if (!capture.ok) return capture;
      }
      return addTypedOutputTransformPass(context.graph, output.value, surface.storage, {
        outputOnly: true,
        fragmentEntryPoint: 'fs_present',
        dither: false,
      });
    },
  });
}
