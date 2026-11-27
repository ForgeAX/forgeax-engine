import { renderFeatureViewIdentity } from '../features/view';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineTopology } from '../render-pipeline';
import { hasScreenAoPrograms, ssaoUsesLighting } from '../ssao-config';
import { standardAoSceneDataUnavailable } from '../temporal/standard-scene-data-admission';
import { recordContext } from '../world/view-record-context';
import type { RenderFrameState } from './frame-snapshot';
import type { PipelineState, RenderSystemInternals } from './render-context';

export function admitStandardAoConfig(
  internals: RenderSystemInternals,
  pipelineState: PipelineState,
  config: RenderPipelineTopology['config'],
): RenderPipelineTopology['config'] {
  const ao = config?.ambientOcclusion;
  const available =
    hasScreenAoPrograms(pipelineState, internals.depthPyramidShaders) &&
    recordContext(internals).captureView === undefined;
  return available || !ssaoUsesLighting(ao)
    ? config
    : { ...config, ambientOcclusion: { ...ao, enabled: false } };
}

export function standardAoUnavailableForGraph(input: {
  readonly internals: RenderSystemInternals;
  readonly frameState: RenderFrameState;
  readonly camera: CameraSnapshot;
  readonly topology: RenderPipelineTopology;
  readonly stockRecording: boolean;
  readonly deviceGeneration: number;
}): ReturnType<typeof standardAoSceneDataUnavailable> {
  if (
    !input.stockRecording ||
    input.topology.clearOnly ||
    input.topology.standardProfile?.renderPath === 'forward' ||
    !ssaoUsesLighting(input.topology.config?.ambientOcclusion)
  ) {
    return undefined;
  }
  return standardAoSceneDataUnavailable({
    admission: input.frameState.standardSceneSurfaceAdmission,
    viewIdentity: renderFeatureViewIdentity(input.camera),
    generation: recordContext(input.internals).featureHost?.preparedGeneration ?? 0,
    deviceGeneration: input.deviceGeneration,
    renderPath: input.topology.standardProfile?.renderPath,
    fallbackLane: input.topology.lane.storageBuffer
      ? 'clustered'
      : input.internals.device.caps.backendKind === 'wgpu-webgl2'
        ? 'cpu-webgl2'
        : 'direct',
  });
}

export function standardGtaoTemporalDemand(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
): boolean {
  const ao = frameState.installedPipelineConfig?.ambientOcclusion;
  return (
    (frameState.cameraStandardProfile ?? internals.standardProfile)?.renderPath === 'deferred' &&
    ssaoUsesLighting(ao) &&
    ao?.method === 'gtao' &&
    ao.gtao?.temporalFilter !== false &&
    hasScreenAoPrograms(recordContext(internals).getPipelineState(), internals.depthPyramidShaders)
  );
}
