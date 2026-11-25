import type { RenderGraphError } from '@forgeax/engine-render-graph';
import { RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { isMultisampleAntialias } from '../components/camera';
import { computeBindGroup } from '../compute-graph-state';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import { createRasterState, type RasterState } from '../raster-graph-state';
import {
  createRenderPipelineTarget,
  type RenderPipelineTarget,
  type RenderPipelineTopology,
} from '../render-pipeline';
import { addSsrCompositionPass } from '../ssr/compose';
import { addSsrSpatialPasses } from '../ssr/graph';
import { addSsrHitColor } from '../ssr/hit-color';
import type { TemporalSecondaryReactivity } from '../typed-render-graph-primitives';
import { sceneViewImport } from './gpu-occlusion';
import { renderInternalCopySize } from './render-extent';
import type { StandardPipelineBuildContext } from './standard-build-context';
import { type ReadViewHzb, viewHzb } from './standard-view-hzb';

/** The separate Forward trace consumes the reflection surface and BRDF from Base Pass. */
export function addForwardSsr(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  input: {
    readonly scene: RenderPipelineTarget;
    readonly fallback: RenderPipelineTarget | undefined;
    readonly response: RenderPipelineTarget | undefined;
    readonly hzb?: ReadViewHzb | undefined;
    readonly depth: RenderPipelineTarget;
    readonly surface: RenderPipelineTarget | undefined;
    readonly temporal: RenderPipelineTarget | undefined;
  },
): Result<TemporalSecondaryReactivity | undefined, RenderGraphError> {
  const { fallback, response, surface, temporal } = input;
  if (
    topology.ssr?.status !== 'admitted' ||
    fallback === undefined ||
    response === undefined ||
    surface === undefined ||
    temporal === undefined
  )
    return ok(undefined);
  const graph = context.graph;
  const view = sceneViewImport(graph)();
  if (!view.ok) return view;
  const depth = graph.view(input.depth.texture, {
    label: 'ssr-forward-depth',
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!depth.ok) return depth;
  const size = renderInternalCopySize(topology);
  const normal = packForwardSsrSurface(graph, surface, size);
  if (!normal.ok) return normal;
  const execution = topology.lane.compute ? 'compute' : 'fragment';
  const pyramid = (input.hzb ?? viewHzb(context, topology, depth.value, size))();
  if (!pyramid.ok) return pyramid;
  const hitColor = addSsrHitColor(context, input.scene, size, 'ssr-scene-color');
  if (!hitColor.ok) return hitColor;
  const spatial = addSsrSpatialPasses(graph, {
    quality: topology.standardProfile?.quality?.ssr,
    admission: topology.ssr,
    execution,
    ...size,
    depth: depth.value,
    normal: normal.value.view,
    scene: hitColor.value.view,
    forwardSampleCount:
      topology.lane.multisample && isMultisampleAntialias(topology.camera.antialias) ? 4 : 1,
    fallback: fallback.view,
    currentTemporal: temporal.view,
    view: view.value,
    depthPyramid: pyramid.value,
  });
  if (!spatial.ok) return spatial;
  const resources = spatial.value.resources;
  if (resources === undefined) return ok(undefined);
  const composed = addSsrCompositionPass(graph, {
    execution,
    scene: input.scene,
    radiance: resources.trace.view,
    fallback: fallback.view,
    response: response.view,
    normal: normal.value.view,
    view: view.value,
  });
  if (!composed.ok) return composed;
  const reactivity = spatial.value.reactivity;
  const reactivitySurface = spatial.value.reactivitySurface;
  return ok(
    reactivity === undefined || reactivitySurface === undefined
      ? undefined
      : { view: reactivity, ...reactivitySurface },
  );
}

function packForwardSsrSurface(
  graph: StandardPipelineBuildContext['graph'],
  surface: RenderPipelineTarget,
  size: { readonly width: number; readonly height: number },
): Result<RenderPipelineTarget, RenderGraphError> {
  const normal = createRenderPipelineTarget(graph, 'ssr-forward-normal', {
    format: 'r32uint',
    size,
    usage: GPU_TEXTURE_USAGE_COPY_SRC,
  });
  if (!normal.ok) return normal;
  let pack: RasterState | undefined;
  const packed = graph.addRasterPass('ssr-forward-pack-surface', {
    accesses: [
      { resource: surface.view, usage: 'sampled-read' },
      { resource: normal.value.view, usage: 'color-attachment' },
    ],
    colorAttachments: [{ view: normal.value.view, loadOp: 'clear', storeOp: 'store' }],
    encodeDirect(pass, frame, resources) {
      const source = frame.ssrShaders?.composeFragment ?? frame.ssrShaders?.compose;
      if (source === undefined)
        throw new RhiError({
          code: 'feature-not-enabled',
          expected: 'the cooked Forward SSR material surface reader',
          hint: 'Load the SSR composition shader before recording the Forward reflection surface.',
        });
      pack ??= createRasterState(
        frame,
        source,
        'ssr-forward-pack-surface',
        [{ binding: 8, visibility: 2, texture: { sampleType: 'unfilterable-float' } }],
        'vs_pack_forward_surface',
        'fs_pack_forward_surface',
        ['r32uint'],
      );
      pass.setPipeline(pack.pipeline);
      pass.setBindGroup(
        0,
        computeBindGroup(frame, pack, [
          {
            binding: 8,
            resource: { kind: 'textureView', value: resources.textureView(surface.view).unwrap() },
          },
        ]),
      );
      pass.draw(3);
    },
  });
  return packed.ok ? normal : packed;
}
