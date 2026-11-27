import {
  createPremultipliedForwardPipeline,
  type RenderPipeline,
} from '@forgeax/engine-render/authoring';

/** r187 WebGPU blends premultiplied linear color and encodes unassociated color once. */
export function createThreePipeline(
  format: 'rgba16float' | 'rgba8unorm' = 'rgba16float',
): RenderPipeline {
  return createPremultipliedForwardPipeline(format, 'three-output');
}
