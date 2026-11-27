import { BLOOM_PREFILTER_WGSL } from '@forgeax/engine-shader';
import type {
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTarget,
} from '../render-pipeline';
import { addTypedFullscreenPass } from '../typed-render-graph-primitives';
import { declarePostSceneColorHalf } from './post-scene-color';

export const BLOOM_PREFILTER_PROGRAM = {
  name: 'forgeax.bloom-prefilter',
  kind: 'fullscreen' as const,
  reads: ['input'] as const,
  params: { byteSize: 16, defaultValue: new Uint8Array(16) },
  source: BLOOM_PREFILTER_WGSL,
};

export function addBloomPrefilter(
  graph: RenderPipelineBuildContext<RenderPipelineFrame>['graph'],
  outputExtent: { readonly width: number; readonly height: number },
  halfScene: RenderPipelineTarget,
) {
  const filtered = declarePostSceneColorHalf(graph, outputExtent, 'bloom-prefilter');
  if (!filtered.ok) return filtered;
  const values = new Float32Array(4);
  const bytes = new Uint8Array(values.buffer);
  const added = addTypedFullscreenPass(graph, {
    name: 'bloom-prefilter',
    shader: BLOOM_PREFILTER_PROGRAM.name,
    input: halfScene,
    outputs: [filtered.value],
    paramsTransform: (_previous, frame) => {
      values[0] = frame.camera.bloomThreshold;
      values[1] = frame.camera.bloomSmoothWidth;
      return bytes;
    },
  });
  return added.ok ? filtered : added;
}
