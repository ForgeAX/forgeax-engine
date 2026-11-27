import type { GraphTextureView, RenderGraphError } from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { addDepthPyramidPasses, type DepthPyramid } from '../depth-pyramid/graph';
import type { DepthPyramidExtent } from '../depth-pyramid/plan';
import type { RenderPipelineTopology } from '../render-pipeline';
import { resolveSsaoQuality, ssaoUsesLighting } from '../ssao-config';
import { sceneViewImport } from './gpu-occlusion';
import type { StandardPipelineBuildContext } from './standard-build-context';

export type ReadViewHzb = () => Result<DepthPyramid, RenderGraphError>;

/** Bind one hierarchy to a particular version of opaque depth. */
export function viewHzb(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  depth: GraphTextureView,
  size: DepthPyramidExtent,
  mipLevelLimit?: number,
  label = 'hzb',
  resolveMsaa = false,
): ReadViewHzb {
  const { graph } = context;
  const importView = sceneViewImport(graph);
  let hzb: ReturnType<ReadViewHzb> | undefined;
  return () => {
    if (hzb !== undefined) return hzb;
    const view = importView();
    if (!view.ok) return view;
    const added = addDepthPyramidPasses(graph, {
      label,
      nativeInputs: context.nativeInputs,
      execution:
        topology.lane.compute && topology.lane.storageTexture !== false ? 'compute' : 'fragment',
      depth,
      paddedView: true,
      ...(resolveMsaa ? { multisampled: 'nearest' as const } : {}),
      view: view.value,
      ...(mipLevelLimit === undefined ? {} : { mipLevelLimit }),
      ...size,
    });
    hzb = added.ok ? ok(added.value.pyramid) : added;
    return hzb;
  };
}

export function standardAoHzbLevels(topology: RenderPipelineTopology): number {
  const ao = topology.config?.ambientOcclusion;
  return ssaoUsesLighting(ao) &&
    ao?.method === 'gtao' &&
    topology.standardProfile?.renderPath !== 'forward'
    ? 3 + Math.max(0, 2 - resolveSsaoQuality(ao).permutation)
    : 1;
}
