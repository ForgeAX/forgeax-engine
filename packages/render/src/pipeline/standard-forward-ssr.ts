import type { RenderGraphError } from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { addDepthPyramidPasses } from '../depth-pyramid/graph';
import type { RenderPipelineTarget, RenderPipelineTopology } from '../render-pipeline';
import { addSsrCompositionPass } from '../ssr/compose';
import { addSsrSpatialPasses } from '../ssr/graph';
import type { StandardSceneSurfaceDataTargets } from '../temporal/standard-scene-data';
import type { TemporalSecondaryReactivity } from '../typed-render-graph-primitives';
import { sceneViewImport } from './gpu-occlusion';
import { renderInternalCopySize } from './render-extent';
import type { StandardPipelineBuildContext } from './standard-build-context';

/** Forward consumes the shared surface producer and its own exact BRDF MRT output. */
export function addForwardSsr(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  input: {
    readonly scene: RenderPipelineTarget;
    readonly fallback: RenderPipelineTarget | undefined;
    readonly response: RenderPipelineTarget | undefined;
    readonly surface: StandardSceneSurfaceDataTargets | undefined;
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
  const depth = graph.view(surface.depth.texture, {
    label: 'ssr-forward-depth',
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!depth.ok) return depth;
  const size = renderInternalCopySize(topology);
  const execution = topology.lane.compute ? 'compute' : 'fragment';
  const pyramid = addDepthPyramidPasses(graph, {
    depth: depth.value,
    view: view.value,
    ...size,
    execution,
  });
  if (!pyramid.ok) return pyramid;
  const history = context.ssrHistory;
  const spatial = addSsrSpatialPasses(graph, {
    admission: topology.ssr,
    execution,
    ...size,
    depth: depth.value,
    normal: surface.normal.view,
    scene: input.scene.view,
    fallback: fallback.view,
    currentTemporal: temporal.view,
    view: view.value,
    depthPyramid: pyramid.value.pyramid,
    ...(history === undefined
      ? {}
      : {
          temporal: {
            previousHistory: history.previous.view,
            outputHistory: history.output.view,
            previousSurface: history.previousSurface.view,
            outputSurface: history.outputSurface.view,
            params: history.params,
          },
        }),
  });
  if (!spatial.ok) return spatial;
  const resources = spatial.value.resources;
  if (resources === undefined) return ok(undefined);
  const composed = addSsrCompositionPass(graph, {
    execution,
    mipLevelCount: resources.mipLevelCount ?? 1,
    scene: input.scene,
    radiance: resources.radiancePyramid ?? resources.trace.view,
    fallback: fallback.view,
    response: response.view,
    normal: surface.normal.view,
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
