import type {
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';

/** One producer for native before-pass depth, independent of the attachment writer. */
export function addBeforePassDepthSnapshot<FrameCtx extends RenderGraphFrame>(
  graph: RenderGraphBuilder<FrameCtx>,
  source: { readonly texture: GraphTexture; readonly view: GraphTextureView },
  label: string,
  copyLabel: string,
  executeIf: (frame: FrameCtx) => boolean,
): Result<{ texture: GraphTexture; view: GraphTextureView }, RenderGraphError> {
  const texture = graph.createTextureLike(label, source.texture);
  if (!texture.ok) return texture;
  const view = graph.view(texture.value, { aspect: 'depth-only', dimension: '2d' });
  if (!view.ok) return view;
  const copied = graph.addCopyPass(copyLabel, {
    accesses: [
      { resource: source.view, usage: 'copy-src' },
      { resource: view.value, usage: 'copy-dst' },
    ],
    executeIf,
    encodeDirect(encoder, _frame, resources) {
      encoder.copyTextureToTexture(
        { texture: resources.texture(source.texture).unwrap(), aspect: 'all' },
        { texture: resources.texture(texture.value).unwrap(), aspect: 'all' },
        { ...resources.textureViewExtent(source.view).unwrap(), depthOrArrayLayers: 1 },
      );
    },
  });
  return copied.ok ? ok({ texture: texture.value, view: view.value }) : copied;
}
