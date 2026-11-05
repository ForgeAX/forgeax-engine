import type { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import type { _InternalRenderPipelineContext } from './render-context';
import type { ScenePassSelection } from './scene-pass-selection';
import type { ScenePassRequest } from './scene-pass-work';

/** Immutable request facts declared by this exact typed graph pass, without a frame plan. */
export interface ScenePipelineDemand {
  readonly pass: ScenePassRequest;
  readonly formats: readonly GPUTextureFormat[];
  readonly sampleCount: RenderPipelineTarget['sampleCount'];
  readonly fragmentEntryPoint: string | undefined;
  readonly coverageOnly: boolean;
  readonly transparentDepthWrite: boolean;
  readonly selection?: ScenePassSelection;
}

export type ScenePipelinePreparation = ((
  context: _InternalRenderPipelineContext,
  artifacts: ReadonlyMap<string, MaterialShaderArtifact>,
) => boolean) & { readonly demand?: ScenePipelineDemand };

// Metadata belongs to this exact graph build, alongside its actual raster declarations.
const preparations = new WeakMap<
  RenderGraphBuilder<RenderPipelineFrame>,
  ScenePipelinePreparation[]
>();

export function registerScenePipelinePreparation(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepare: ScenePipelinePreparation,
  demand?: ScenePipelineDemand,
): void {
  if (demand !== undefined)
    Object.defineProperty(prepare, 'demand', {
      value: Object.freeze({ ...demand, formats: Object.freeze(Array.from(demand.formats)) }),
    });
  const entries = preparations.get(graph);
  if (entries === undefined) preparations.set(graph, [prepare]);
  else entries.push(prepare);
}

export function scenePipelinePreparations(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
): readonly ScenePipelinePreparation[] {
  return preparations.get(graph) ?? [];
}
