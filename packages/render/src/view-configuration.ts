import type { RenderPipelineAsset, Result } from '@forgeax/engine-types';
import type { DynamicGeometryError } from './dynamic-geometry';
import { validateClusterGrid } from './pipeline/standard-pipeline';
import { DEFAULT_CLUSTER_GRID, STANDARD_PIPELINE_ID } from './pipeline/standard-profile';
import {
  type CandidatePipelineDemandReader,
  type CandidatePipelineInput,
  CandidatePipelinePreparationOwner,
  type PreparedCandidatePipelines,
} from './record/candidate-pipeline-preparation';
import { resolveSsaoParameters, ssaoStructuralIdentity } from './ssao-config';
import type { ViewSettlementOwner } from './world/view-settlement';

/**
 * Install the Standard configuration on one view. Invalid cluster grids and
 * SSAO parameters are rejected at this public configuration boundary before
 * any view state changes.
 */
export function configureViewStandard(
  owner: ViewSettlementOwner,
  config: RenderPipelineAsset['config'],
): void {
  const { frameState, internals } = owner;
  const profileConfig = internals.standardProfile;
  if (profileConfig?.probePlacement === undefined) frameState.probePlacement?.disable();
  const resolvedConfig =
    profileConfig === undefined
      ? config
      : {
          clusterGrid: DEFAULT_CLUSTER_GRID,
          ssao: {
            enabled: profileConfig.ssao !== false,
            ...(typeof profileConfig.ssao === 'object' ? profileConfig.ssao : {}),
          },
          ...(profileConfig.gpuOcclusion === undefined
            ? {}
            : { gpuOcclusion: profileConfig.gpuOcclusion }),
          ...config,
        };
  if (resolvedConfig?.clusterGrid !== undefined) {
    const gridResult = validateClusterGrid(resolvedConfig.clusterGrid);
    if (!gridResult.ok) throw gridResult.error;
  }
  if (resolvedConfig?.ssao?.enabled === true) {
    const ssaoResult = resolveSsaoParameters(resolvedConfig.ssao);
    if (!ssaoResult.ok) throw ssaoResult.error;
  }
  // Install is a rare boot/swap event: a monotonic epoch forces the next
  // frame's graph rebuild, even for an identical re-install.
  frameState.installedPipelineHandle += 1;
  frameState.standardInstall.configured = resolvedConfig;
  frameState.installedPipelineConfig = resolvedConfig;
  frameState.cameraStandardProfile = undefined;
  frameState.standardInstall.cameraSignature = JSON.stringify([
    profileConfig?.renderPath,
    ssaoStructuralIdentity(
      resolvedConfig?.ssao,
      profileConfig?.pipelineId === STANDARD_PIPELINE_ID,
    ),
  ]);
}

/** Seed a new view from `source`: built-in post-processes, Standard configuration and SSR device facts. */
export function seedViewConfiguration(
  source: ViewSettlementOwner,
  target: ViewSettlementOwner,
): void {
  for (const [id, entry] of source.postProcess.params.builtinEntries)
    target.postProcess.params.registerBuiltinPostProcess(id, entry);
  configureViewStandard(target, source.frameState.standardInstall.configured);
  const device = source.internals.device;
  const receipt = source.ssrFormats.get(device);
  if (receipt !== undefined) target.ssrFormats.set(device, receipt);
}

/** Await one view's real pipelines for the candidate credentials against its compiled graph. */
export function prepareViewCandidatePipelines(
  owner: ViewSettlementOwner,
  input: CandidatePipelineInput,
  signal?: AbortSignal,
  readDemand?: CandidatePipelineDemandReader,
): Promise<Result<PreparedCandidatePipelines, DynamicGeometryError>> {
  const { frameState } = owner;
  frameState.candidatePipelinePreparations ??= new CandidatePipelinePreparationOwner(
    () => frameState.compiledFrameGraph,
    readDemand,
  );
  return frameState.candidatePipelinePreparations.prepare(input, signal);
}
