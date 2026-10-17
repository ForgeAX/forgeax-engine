import type {
  GraphAccess,
  GraphBuffer,
  RenderGraphBuilder,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { ok } from '@forgeax/engine-types';
import { currentRenderFeaturePass } from './frame-execution';
import type { RenderFeaturePlanExecutionPass } from './host';
import {
  importRenderFeatureGraphBuffer,
  type RenderFeatureGraphBufferState,
} from './render-graph-resources';

/** Copy descriptors consume the same admitted, generation-owned buffers as compute and raster. */
export function projectRenderFeatureCopies<FrameCtx extends RenderGraphFrame>(
  builder: RenderGraphBuilder<FrameCtx>,
  state: RenderFeatureGraphBufferState,
  pass: RenderFeaturePlanExecutionPass,
  scope?: string,
) {
  const copies = pass.resolvedGpuCopies;
  if (copies === undefined) return ok(undefined);
  const accesses: GraphAccess[] = [];
  // Deduplicate each usage independently so source/destination aliases still conflict.
  const sources = new Set<GraphBuffer>();
  const destinations = new Set<GraphBuffer>();
  for (const [index, copy] of copies.entries()) {
    const source = importRenderFeatureGraphBuffer(
      builder,
      state,
      `${pass.name}.source-${index}`,
      copy.source,
    );
    if (!source.ok) return source;
    const destination = importRenderFeatureGraphBuffer(
      builder,
      state,
      `${pass.name}.destination-${index}`,
      copy.destination,
    );
    if (!destination.ok) return destination;
    if (!sources.has(source.value)) {
      sources.add(source.value);
      accesses.push({ resource: source.value, usage: 'copy-src' });
    }
    if (!destinations.has(destination.value)) {
      destinations.add(destination.value);
      accesses.push({ resource: destination.value, usage: 'copy-dst' });
    }
  }
  return builder.addCopyPass(pass.name, {
    accesses,
    executeIf: (frame) =>
      currentRenderFeaturePass(frame, pass.featureIdentity, pass.name, scope)?.enabled ??
      pass.enabled ??
      true,
    encode: ({ encoder, frame }) => {
      const current =
        currentRenderFeaturePass(frame, pass.featureIdentity, pass.name, scope)
          ?.resolvedGpuCopies ?? copies;
      for (const copy of current) {
        if (copy.enabled === false) continue;
        encoder.copyBufferToBuffer(
          copy.source.buffer,
          copy.sourceOffset,
          copy.destination.buffer,
          copy.destinationOffset,
          copy.size,
        );
      }
    },
  });
}
