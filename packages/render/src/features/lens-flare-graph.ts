import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../render-pipeline';
import { addTypedFullscreenPass } from '../typed-render-graph-primitives';
import {
  LENS_FLARE_BLUR_ID,
  LENS_FLARE_COMPOSITE_ID,
  LENS_FLARE_GUARD_BAND,
  LENS_FLARE_PREFILTER_ID,
} from './lens-flare';

/**
 * The guard band covers LENS_FLARE_GUARD_BAND times the view at 1/8 of its
 * linear density, so the two gather passes run on 1/41 of the output pixels.
 */
export function lensFlareGuardBandSize(output: {
  readonly width: number;
  readonly height: number;
}): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width: Math.max(1, Math.ceil((output.width * LENS_FLARE_GUARD_BAND) / 8)),
    height: Math.max(1, Math.ceil((output.height * LENS_FLARE_GUARD_BAND) / 8)),
  };
}

export function addLensFlarePasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  output: { readonly width: number; readonly height: number },
): Result<RenderPipelineTarget, RenderGraphError> {
  const guardBand = lensFlareGuardBandSize(output);
  const prefiltered = createRenderPipelineTarget(graph, 'standard-lens-flare-prefilter', {
    format: 'rgba16float',
    size: guardBand,
    domain: 'linear-hdr',
  });
  if (!prefiltered.ok) return prefiltered;
  const bokeh = createRenderPipelineTarget(graph, 'standard-lens-flare-bokeh', {
    format: 'rgba16float',
    size: guardBand,
    domain: 'linear-hdr',
  });
  if (!bokeh.ok) return bokeh;
  const composited = createRenderPipelineTarget(graph, 'standard-lens-flare', {
    format: 'rgba16float',
    size: { width: output.width, height: output.height },
    domain: 'linear-hdr',
  });
  if (!composited.ok) return composited;
  const thresholded = addTypedFullscreenPass(graph, {
    name: 'standard-lens-flare-prefilter',
    shader: LENS_FLARE_PREFILTER_ID,
    clearColor: [0, 0, 0, 1],
    input,
    outputs: [prefiltered.value],
  });
  if (!thresholded.ok) return thresholded;
  const blurred = addTypedFullscreenPass(graph, {
    name: 'standard-lens-flare-bokeh',
    shader: LENS_FLARE_BLUR_ID,
    clearColor: [0, 0, 0, 1],
    input: prefiltered.value,
    outputs: [bokeh.value],
  });
  if (!blurred.ok) return blurred;
  const ghosts = addTypedFullscreenPass(graph, {
    name: 'standard-lens-flare',
    shader: LENS_FLARE_COMPOSITE_ID,
    input,
    outputs: [composited.value],
    additionalReads: [{ key: 'lens-flare-bokeh', target: bokeh.value }],
  });
  return ghosts.ok ? ok(composited.value) : ghosts;
}
