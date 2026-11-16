import type {
  GraphAccess,
  GraphBuffer,
  RenderGraphBuilder,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { ok } from '@forgeax/engine-types';
import { encodeFrameObservationCapture } from '../record/observation-capture';
import type { RenderPipelineFrame } from '../render-pipeline';
import { currentRenderFeaturePass } from './frame-execution';
import type { RenderFeaturePlanExecutionPass } from './host';
import type { RenderFeatureGraphTargetResolver } from './render-graph-raster';
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
  graphName = pass.name,
  resolveTarget?: RenderFeatureGraphTargetResolver,
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
  for (const readback of pass.textureReadbacks ?? []) {
    const target = resolveTarget?.(readback.target);
    if (target !== undefined) accesses.push({ resource: target.view, usage: 'copy-src' });
  }
  return builder.addCopyPass(graphName, {
    accesses,
    executeIf: (frame) =>
      currentRenderFeaturePass(frame, pass.featureIdentity, pass.name, scope)?.enabled ??
      pass.enabled ??
      true,
    encodeDirect: (encoder, frame, graphresources) => {
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
      const active =
        currentRenderFeaturePass(frame, pass.featureIdentity, pass.name, scope) ?? pass;
      for (const readback of active.textureReadbacks ?? []) {
        const target = resolveTarget?.(readback.target);
        const descriptor = readback.target.descriptor;
        const targetName = readback.target.name;
        if (target === undefined || descriptor === undefined || targetName === undefined)
          throw new Error('A declared feature readback requires its current named graph texture');
        const pipeline = frame as unknown as RenderPipelineFrame;
        const resource = graphresources.texture(target.texture).unwrap();
        const graphGeneration = pipeline.runtime.observationGraphGeneration;
        if (graphGeneration === undefined)
          throw new Error('A feature readback requires its current execution graph identity');
        encodeFrameObservationCapture(pipeline.runtime, encoder, {
          texture: resource,
          format: descriptor.format,
          domain: 'feature-texture',
          featureTexture: {
            featureIdentity: pass.featureIdentity,
            name: readback.name,
            targetName,
            viewIdentity: readback.target.allocationScope ?? scope ?? 'frame',
          },
          width: descriptor.size.width,
          height: descriptor.size.height,
          frameNumber: pipeline.runtime.observationFrameId ?? 0,
          graphGeneration,
        });
      }
    },
  });
}
