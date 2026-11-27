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
  LENS_FLARE_WITH_BLOOM_ID,
} from './lens-flare';

export const LENS_FLARE_PREFILTER = 'standard-lens-flare-prefilter';
export const LENS_FLARE_BOKEH = 'standard-lens-flare-bokeh';
export const LENS_FLARE_COMBINED = 'standard-lens-flare';

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
  halfScene: RenderPipelineTarget,
  output: { readonly width: number; readonly height: number },
  bloom?: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderGraphError> {
  const guardBand = lensFlareGuardBandSize(output);
  const prefiltered = createRenderPipelineTarget(graph, LENS_FLARE_PREFILTER, {
    format: 'rgba16float',
    size: guardBand,
    domain: 'linear-hdr',
  });
  if (!prefiltered.ok) return prefiltered;
  const bokeh = createRenderPipelineTarget(graph, LENS_FLARE_BOKEH, {
    format: 'rgba16float',
    size: guardBand,
    domain: 'linear-hdr',
  });
  if (!bokeh.ok) return bokeh;
  const composited = createRenderPipelineTarget(graph, LENS_FLARE_COMBINED, {
    format: 'rgba16float',
    size: { width: Math.ceil(output.width / 2), height: Math.ceil(output.height / 2) },
    domain: 'linear-hdr',
  });
  if (!composited.ok) return composited;
  const thresholded = addTypedFullscreenPass(graph, {
    name: LENS_FLARE_PREFILTER,
    shader: LENS_FLARE_PREFILTER_ID,
    clearColor: [0, 0, 0, 1],
    input: halfScene,
    outputs: [prefiltered.value],
  });
  if (!thresholded.ok) return thresholded;
  const blurred = addTypedFullscreenPass(graph, {
    name: LENS_FLARE_BOKEH,
    shader: LENS_FLARE_BLUR_ID,
    clearColor: [0, 0, 0, 1],
    input: prefiltered.value,
    outputs: [bokeh.value],
  });
  if (!blurred.ok) return blurred;
  const ghosts = addTypedFullscreenPass(graph, {
    name: LENS_FLARE_COMBINED,
    shader: bloom === undefined ? LENS_FLARE_COMPOSITE_ID : LENS_FLARE_WITH_BLOOM_ID,
    input: bokeh.value,
    outputs: [composited.value],
    ...(bloom === undefined ? {} : { additionalReads: [{ key: 'bloom', target: bloom }] }),
  });
  return ghosts.ok ? ok(composited.value) : ghosts;
}
