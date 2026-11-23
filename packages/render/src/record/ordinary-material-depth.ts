import type {
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { BindGroup, BindGroupLayout, RenderPipeline, TextureView } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { materialUsesLitSceneInputs } from '../pbr-pipeline';
import { addMultisampleDepthResolve } from '../pipeline/analytic-fog-pass';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import { matchPass } from '../systems/pass-selector';
import { buildViewBindGroup } from './frame-lighting';
import { selectMainPassMaterials } from './main-pass';
import type { _InternalRenderPipelineContext, RenderSystemInternals } from './render-context';
import { addBeforePassDepthSnapshot } from './scene-depth-snapshot';
import { type ScenePassRequest, scenePassMaterialRows } from './scene-pass-work';

/** The actual selected ordinary Pass roster is the depth-demand authority. */
export function ordinaryMaterialDepthDemand(
  frame: RenderPipelineFrame,
  request: ScenePassRequest,
): boolean {
  const internal = frame as _InternalRenderPipelineContext;
  const c = scenePassMaterialRows(internal, request);
  const selected = selectMainPassMaterials(
    c,
    request.selector,
    request.recordMode,
    request.excludeSelector,
  );
  return c.dispatch.some(
    (pass) =>
      (selected === null ||
        selected.get(pass.renderableIndex)?.has(pass.materialHandle) === true) &&
      (request.selector === undefined || matchPass(pass.tags, request.selector)) &&
      materialUsesLitSceneInputs(internal.runtime.shaderRegistry, pass.materialShaderId),
  );
}

/** Independent storage keeps before-pass sampling disjoint from the depth writer. */
export function addOrdinaryMaterialDepthSnapshot(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  depth: RenderPipelineTarget,
  name: string,
  executeIf: (frame: RenderPipelineFrame) => boolean,
  clearDepth = false,
): Result<GraphTextureView, RenderGraphError> {
  if (depth.sampleCount === 1 && !clearDepth) {
    const snapshot = addBeforePassDepthSnapshot(
      graph,
      depth,
      `${name}.material-depth`,
      `${name}.material-depth-copy`,
      executeIf,
    );
    return snapshot.ok ? ok(snapshot.value.view) : snapshot;
  }
  const texture = graph.createTextureLike(`${name}.material-depth`, depth.texture, 1);
  if (!texture.ok) return texture;
  const view = graph.view(texture.value, { aspect: 'depth-only', dimension: '2d' });
  if (!view.ok) return view;
  if (clearDepth) {
    const attachment = graph.view(texture.value);
    if (!attachment.ok) return attachment;
    const cleared = graph.addRasterPass(`${name}.material-depth-clear`, {
      accesses: [{ resource: attachment.value, usage: 'depth-stencil-write' }],
      executeIf,
      colorAttachments: [],
      depthStencilAttachment: {
        view: attachment.value,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
        ...(depth.format.includes('stencil')
          ? {
              stencilLoadOp: 'clear' as const,
              stencilStoreOp: 'store' as const,
              stencilClearValue: 0,
            }
          : {}),
      },
      encodeDirect() {},
    });
    return cleared.ok ? ok(view.value) : cleared;
  }
  if (depth.sampleCount === 4)
    return addMultisampleDepthResolve(
      graph,
      depth,
      { ...depth, texture: texture.value, view: view.value, sampleCount: 1 },
      `${name}.material-depth-resolve`,
      executeIf,
    );
  return ok(view.value);
}

/** Reuse the full native View resource owner with the actual graph-owned depth. */
export function ordinaryMaterialViewGroup(
  c: _InternalRenderPipelineContext,
  pipeline: RenderPipeline,
  shader: string | undefined,
  depth: TextureView | undefined,
): BindGroup | undefined {
  if (!materialUsesLitSceneInputs(c.runtime.shaderRegistry, shader)) return undefined;
  if (depth === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the ordinary material before-pass scene-depth snapshot',
      hint: 'declare and execute the native sampled-depth producer before this Scene Pass',
    });
  const getLayout = (
    pipeline as RenderPipeline & { getBindGroupLayout?: (index: number) => BindGroupLayout }
  ).getBindGroupLayout;
  const layout = getLayout?.call(pipeline, 0);
  if (layout === undefined || getLayout === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the selected ordinary material full View/depth layout',
      hint: 'retain the selected pipeline layout through recording',
    });
  const result = buildViewBindGroup(
    c.runtime as RenderSystemInternals,
    c.frameState,
    c.pipelineState,
    c.bindGroupCounts,
    {
      ...c.ordinaryDepthViewTargets,
      viewBindGroupLayout: layout,
      viewLayoutIdentity: [pipeline, getLayout],
      sceneDepth: depth,
    },
  );
  if (result === null)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the ordinary material full View/depth bind group',
      hint: 'prepare native frame lighting before ordinary geometry',
    });
  return result;
}
