import type {
  GraphAccess,
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-rhi';
import type { RenderError } from '../errors/render';
import { projectRenderFeaturePlans } from '../features/render-graph-contribution';
import type { RenderPipelineFeatureTarget, RenderPipelineFrame } from '../render-pipeline';
import type { TypedShadowTargets } from '../typed-shadow-passes';
import { resolveLightingBinding } from './standard-feature-contribution';
import type { CubeCaptureGraphWork } from './target-capture-graph';
import { resolveTargetBindings, targetResolver } from './typed-frame-graph-bindings';

/** One capture face's imported attachments, as the face scene pass drew them. */
export interface CaptureFaceFeatureInput {
  readonly work: CubeCaptureGraphWork;
  readonly color: GraphTextureView;
  readonly colorTexture: GraphTexture;
  readonly depth: GraphTextureView;
  readonly depthTexture: GraphTexture;
  readonly lighting?:
    | undefined
    | { readonly shadows: TypedShadowTargets; readonly accesses: readonly GraphAccess[] };
}

/**
 * Project a capture face's Feature plans into its graph, after the face scene
 * passes and before any mip generation reads the face. A face without plans,
 * or a multisampled face (its resolve target is not a Feature attachment),
 * records none.
 */
export function addCaptureFaceFeaturePasses(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  scenePass: Result<unknown, RenderGraphError>,
  input: CaptureFaceFeatureInput,
): Result<void, RenderGraphError | RenderError> {
  if (!scenePass.ok) return scenePass;
  const executions = input.work.feature?.executions;
  const descriptor = input.work.physical.descriptor;
  if (executions === undefined || executions.length === 0 || descriptor.sampleCount !== 1)
    return ok(undefined);
  const targets: RenderPipelineFeatureTarget[] = [
    {
      name: 'color',
      kind: 'scene-color',
      texture: input.colorTexture,
      view: input.color,
      format: descriptor.format,
      sampleCount: 1,
    },
    {
      name: 'depth',
      kind: 'scene-depth',
      texture: input.depthTexture,
      view: input.depth,
      format: 'depth32float-stencil8',
      sampleCount: 1,
    },
  ];
  return projectRenderFeaturePlans(builder, executions, {
    resolveTarget: targetResolver(targets),
    resolveBindings: (binding) => resolveTargetBindings(binding),
    resolveStandardLighting: resolveLightingBinding,
    standardSurfaceAccesses: input.lighting?.accesses ?? [],
  });
}
