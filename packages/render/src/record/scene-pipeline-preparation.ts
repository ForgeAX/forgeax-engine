import type { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { _InternalRenderPipelineContext } from './render-context';

export type ScenePipelinePreparation = (
  context: _InternalRenderPipelineContext,
  artifacts: ReadonlyMap<string, MaterialShaderArtifact>,
) => boolean;

// Metadata belongs to this exact graph build, alongside its actual raster declarations.
const preparations = new WeakMap<
  RenderGraphBuilder<RenderPipelineFrame>,
  ScenePipelinePreparation[]
>();

export function registerScenePipelinePreparation(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepare: ScenePipelinePreparation,
): void {
  const entries = preparations.get(graph);
  if (entries === undefined) preparations.set(graph, [prepare]);
  else entries.push(prepare);
}

export function scenePipelinePreparations(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
): readonly ScenePipelinePreparation[] {
  return preparations.get(graph) ?? [];
}
