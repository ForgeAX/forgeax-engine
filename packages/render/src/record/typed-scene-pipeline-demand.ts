import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { prepareHiddenGpuDrivenPipelines } from '../gpu-driven/material-artifacts';
import { markPipelinePreparationPending } from '../render-system-presentation';
import type { ValidatedRenderable } from './frame-snapshot';
import type { GeometryPipelinePreparationContext } from './geometry-pipeline-requests';
import { hasMainPassPipelinePreparation, prepareMainPassPipelineDemand } from './main-pass';
import type { _InternalRenderPipelineContext } from './render-context';
import {
  type ScenePassSelectionCamera,
  selectScenePassPipelineEntries,
} from './scene-pass-selection';
import type { ScenePipelineDemand } from './scene-pipeline-preparation';
import { selectForwardFragmentEntry } from './standard-opaque-entry';

/** Exact typed-pass requests, independent of recording, attachments or GPU frame plans. */
export interface TypedScenePipelineDemandContext extends GeometryPipelinePreparationContext {
  readonly selectionCamera?: ScenePassSelectionCamera;
  readonly tonemapActive: boolean;
  readonly viewBindGroupDynamicOffset?: number;
  readonly gpuDrivenGeometryLane: _InternalRenderPipelineContext['gpuDrivenGeometryLane'];
  readonly hasLocalLights: boolean;
  readonly ssao: boolean;
  readonly reflectionFallbackDemand: boolean;
  readonly probeBlend: boolean;
}

export function prepareTypedScenePipelineDemand(
  input: TypedScenePipelineDemandContext,
  artifacts: ReadonlyMap<string, MaterialShaderArtifact>,
  demand: ScenePipelineDemand,
): boolean {
  const { pass, formats, sampleCount, fragmentEntryPoint, coverageOnly } = demand;
  if (demand.selection !== undefined && input.selectionCamera === undefined) {
    markPipelinePreparationPending(input.frameState, { code: 'scene-pipeline-preparation' });
    return false;
  }
  // These formats are the installed pass attachments, exactly as ordinary raster recording.
  const context = {
    ...input,
    pipelinePreparationEntries: selectScenePassPipelineEntries(
      input.pipelinePreparationEntries,
      demand.selection,
      input.selectionCamera,
    ),
    transparentColorFormat: formats[0],
    reflectionFallbackColorFormat:
      pass.passKind !== 'deferred' && formats[1] === 'rgba16float'
        ? ('rgba16float' as const)
        : undefined,
  };
  if (
    pass.selector === undefined ||
    !hasMainPassPipelinePreparation(context, pass.selector, pass.recordMode, pass.excludeSelector)
  )
    return false;
  const gpuDraws = new Map<ValidatedRenderable, Set<number>>();
  const factory = context.runtime.prepareMaterialShaderPipelineEntry;
  if (
    (pass.gpu ||
      (pass.gpuFilter !== undefined &&
        context.gpuDrivenGeometryLane === 'automatic' &&
        context.pipelineState.gpuDrivenInstancesBindGroupLayout != null)) &&
    factory !== undefined &&
    !prepareHiddenGpuDrivenPipelines({
      entries: context.pipelinePreparationEntries ?? [],
      materials: context.materialFrame,
      resolve: (shader, request) =>
        context.runtime.getMaterialShaderArtifact?.(shader, {
          ...(typeof request === 'boolean' ? { vertexColorAvailable: request } : request),
          clustered: context.lightingKind === 'clustered',
          probeBlend: context.probeBlend,
          reflectionFallback: context.reflectionFallbackDemand,
        }),
      artifacts,
      factory,
      formats,
      sampleCount,
      shaderUvSetCount: context.pipelineState.standardPbrShaderUvSetCount,
      filter: pass.gpuFilter,
      fragmentEntry: selectForwardFragmentEntry({
        passKind: pass.passKind,
        fragmentEntry: fragmentEntryPoint,
        oitAccumulate: pass.recordMode === 'oit-accumulate',
        viewOffset: 0,
        atmosphereCapture: false,
      }),
      coverageOnly,
      seededDepth: demand.seededDepth === true,
      visibleSurface: context.visibleSurface,
      // Keep the normal typed pass's explicit preparation contract.
      onSelected: (entry, index) => {
        let draws = gpuDraws.get(entry);
        if (draws === undefined) {
          draws = new Set();
          gpuDraws.set(entry, draws);
        }
        draws.add(index);
      },
      onPending: (reason) => markPipelinePreparationPending(context.frameState, reason),
    })
  )
    markPipelinePreparationPending(context.frameState, { code: 'scene-pipeline-preparation' });
  prepareMainPassPipelineDemand(
    context,
    pass.selector,
    {
      passKind: pass.passKind,
      ...(pass.recordMode === undefined ? {} : { recordMode: pass.recordMode }),
      ...(pass.excludeSelector === undefined ? {} : { excludeSelector: pass.excludeSelector }),
      coverageOnly,
      ...(fragmentEntryPoint === undefined ? {} : { fragmentEntryPoint }),
      transparentDepthWrite: demand.transparentDepthWrite,
      seededDepth: demand.seededDepth === true,
    },
    sampleCount,
    formats,
    (entry, index) => gpuDraws.get(entry)?.has(index) === true,
  );
  return true;
}
