import type { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import type { _InternalRenderPipelineContext } from './render-context';
import type { ScenePassSelection } from './scene-pass-selection';
import type { ScenePassRequest } from './scene-pass-work';

/** Immutable request facts declared by this exact typed graph pass, without a frame plan. */
export interface ScenePipelineDemand {
  readonly bundleDescriptor?: import('@forgeax/engine-rhi').RenderBundleEncoderDescriptor;
  readonly gpuFragmentEntryPoint?: string | undefined;
  readonly gpuPhase?: import('../render-pipeline').GpuDrivenDrawPhase;
  readonly pass: ScenePassRequest;
  readonly bindings?: Pick<
    import('../typed-render-graph-primitives').TypedScenePassOptions,
    | 'directionalShadow'
    | 'spotShadow'
    | 'cloudShadow'
    | 'ssao'
    | 'ssrSource'
    | 'environment'
    | 'atmosphereReads'
    | 'transmissionBackdrop'
    | 'surfacePair'
    | 'surfaceNearestLayer'
    | 'surfaceNearestDepth'
  >;
  readonly formats: readonly GPUTextureFormat[];
  readonly sampleCount: RenderPipelineTarget['sampleCount'];
  readonly fragmentEntryPoint: string | undefined;
  readonly coverageOnly: boolean;
  readonly transparentDepthWrite: boolean;
  readonly seededDepth?: boolean;
  readonly opaqueDepthPrimed?: boolean;
  readonly selection?: ScenePassSelection;
}

/** Facts available once Record has validated the current view's draws. */
export type ScenePipelineSourceContext = Pick<
  _InternalRenderPipelineContext,
  'frameState' | 'runtime' | 'validatedOrdered'
>;

/** Return true only when this preparation matches a candidate material raster lane. */
export type ScenePipelinePreparation = ((
  context: _InternalRenderPipelineContext,
  artifacts: ReadonlyMap<string, MaterialShaderArtifact>,
) => boolean) & {
  readonly demand?: ScenePipelineDemand;
  /** Graph-owned utility programs do not participate in candidate material matching. */
  readonly kind?: 'utility';
  /** Request CPU work before building the native scene pipelines or bindings. */
  readonly prepareSource?: (context: ScenePipelineSourceContext) => void;
};

// Metadata belongs to this exact graph build, alongside its actual raster declarations.
const preparations = new WeakMap<
  RenderGraphBuilder<RenderPipelineFrame>,
  ScenePipelinePreparation[]
>();

export function registerScenePipelinePreparation(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepare: ScenePipelinePreparation,
  demand?: ScenePipelineDemand | 'utility',
): void {
  if (demand === 'utility') Object.defineProperty(prepare, 'kind', { value: 'utility' });
  else if (demand !== undefined)
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
