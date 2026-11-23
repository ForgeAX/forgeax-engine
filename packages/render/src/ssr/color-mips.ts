import type {
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { isTemporalAntialias } from '../components/camera';
import { addGraphColorMipPasses } from '../graph-color-mips';
import {
  createRenderPipelineTarget,
  type RenderPipelineBuildContext,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
  type RenderPipelineTopology,
} from '../render-pipeline';
import { addTypedFullscreenPass } from '../typed-render-graph-primitives';
import {
  SSR_HIT_COLOR_DOWNSAMPLE_PROGRAM,
  ssrColorExtent,
  ssrColorMipCount,
} from './scene-color-input';

type ColorExtent = { readonly width: number; readonly height: number };

type ColorMipContext = Pick<
  RenderPipelineBuildContext<RenderPipelineFrame>,
  'graph' | 'encodeTransmissionMip'
>;

/** Sample the scene once into a dedicated half-resolution linear color target. */
export function addSsrColorDownsample(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  source: RenderPipelineTarget,
  size: ColorExtent,
  label: string,
  mipLevelCount = 1,
): Result<RenderPipelineTarget, RenderGraphError> {
  const target = createRenderPipelineTarget(
    graph,
    label,
    { format: source.format, size, mipLevelCount, domain: source.domain },
    { mipLevelCount: 1 },
  );
  if (!target.ok) return target;
  const pass = addTypedFullscreenPass(graph, {
    name: `${label}-downsample`,
    shader: SSR_HIT_COLOR_DOWNSAMPLE_PROGRAM.name,
    input: source,
    outputs: [target.value],
  });
  return pass.ok ? target : pass;
}

export function addSsrHitColor(
  context: ColorMipContext,
  topology: RenderPipelineTopology,
  source: RenderPipelineTarget,
  sceneSize: ColorExtent,
  label: string,
): Result<{ readonly view: GraphTextureView; readonly mipCount: number }, RenderGraphError> {
  const size = ssrColorExtent(sceneSize);
  const filterable = source.format === 'rgba16float' || source.format === 'rgba8unorm';
  const mipCount =
    filterable &&
    context.encodeTransmissionMip !== undefined &&
    !isTemporalAntialias(topology.camera.antialias)
      ? ssrColorMipCount(size)
      : 1;
  const color = addSsrColorDownsample(context.graph, source, size, label, mipCount);
  if (!color.ok) return color;
  return addSsrColorMips(context, topology, color.value, size, label, mipCount);
}

/** Build the remaining levels after publishing half-resolution level zero. */
export function addSsrColorMips(
  context: ColorMipContext,
  topology: RenderPipelineTopology,
  target: RenderPipelineTarget,
  size: ColorExtent,
  label: string,
  mipCount: number,
): Result<{ readonly view: GraphTextureView; readonly mipCount: number }, RenderGraphError> {
  const { graph, encodeTransmissionMip } = context;
  if (mipCount <= 1 || encodeTransmissionMip === undefined)
    return ok({ view: target.view, mipCount: 1 });
  const mips = addGraphColorMipPasses(
    graph,
    label,
    target.texture,
    { ...size, format: target.format },
    mipCount,
    encodeTransmissionMip,
    target.view,
    topology.lane.compute ? 'webgpu' : 'wgpu-webgl2',
  );
  if (!mips.ok) return mips;
  return ok({ view: mips.value ?? target.view, mipCount });
}
