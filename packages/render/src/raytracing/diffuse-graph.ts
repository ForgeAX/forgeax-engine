import type {
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { Result } from '@forgeax/engine-types';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import { RAY_PATH_STRIDE } from './path-tracer';
import { addRayReconstructionPasses, importRayMaterialTextures } from './ray-graph-shared';
import { addRayReflectionPasses } from './reflections-graph';
import type { PreparedRayDiffuse } from './renderer-diffuse';

export interface RayDiffuseTargets {
  readonly scene: RenderPipelineTarget;
  readonly depth: GraphTextureView;
  readonly normal: RenderPipelineTarget;
  readonly albedo: RenderPipelineTarget;
  readonly f0: RenderPipelineTarget;
  readonly identity: RenderPipelineTarget;
  readonly motion: RenderPipelineTarget;
  /** The view's shared closest-depth pyramid, created on first request. */
  readonly depthPyramid?: () => Result<GraphTextureView, RenderGraphError>;
  /** Deferred split-sum response and the SSR-replaceable fallback; present when any
   * reflection consumer is admitted. Lite reflections add world specular into both. */
  readonly reflection?: {
    readonly fallback: RenderPipelineTarget;
    readonly response: RenderPipelineTarget;
  };
}

/** Declare the actual G-buffer -> receiver -> raw D -> additive HDR dependency chain. */
export function addRayDiffusePasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepared: PreparedRayDiffuse,
  target: RayDiffuseTargets,
) {
  const records = graph
    .importBuffer(
      'ray-diffuse.records',
      { size: prepared.recordBytes, usage: 128 | 8 },
      () => prepared.records,
    )
    .unwrap();
  const rays = graph
    .importBuffer(
      'ray-diffuse.initial-rays',
      { size: prepared.pixelCount * RAY_PATH_STRIDE, usage: 128 | 8 },
      () => prepared.rays,
    )
    .unwrap();
  const sample = graph
    .importBuffer('ray-diffuse.sample', { size: 16, usage: 64 | 8 }, () => prepared.sample)
    .unwrap();
  const view = graph
    .importBuffer(
      'ray-diffuse.view',
      { size: VIEW_UNIFORM_BYTES, usage: 64 | 8 },
      (frame) => frame.pipelineState.viewUniformBuffer,
    )
    .unwrap();
  const generated = graph.addComputePass('ray-diffuse.generate', {
    accesses: [
      { resource: target.depth, usage: 'sampled-read' },
      { resource: target.normal.view, usage: 'sampled-read' },
      { resource: target.identity.view, usage: 'sampled-read' },
      { resource: records, usage: 'storage-read' },
      { resource: view, usage: 'uniform-read' },
      { resource: sample, usage: 'uniform-read' },
      { resource: rays, usage: 'storage-write' },
    ],
    encode: ({ pass, resources }) => {
      if (prepared.fence.currentGeneration() !== prepared.generation)
        throw new Error('stale diffuse GI graph; prepare the current scene');
      prepared.writeSample();
      prepared.generate
        .record(
          pass,
          {
            depth: resources.textureView(target.depth).unwrap(),
            normal: resources.textureView(target.normal.view).unwrap(),
            identity: resources.textureView(target.identity.view).unwrap(),
            records: { buffer: resources.buffer(records).unwrap(), size: prepared.recordBytes },
            view: { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
            sample: resources.buffer(sample).unwrap(),
            rays: resources.buffer(rays).unwrap(),
          },
          prepared.pixelCount,
        )
        .unwrap();
    },
  });
  if (!generated.ok) return generated;
  const textures = importRayMaterialTextures(graph, prepared.textures);
  const accumulation = prepared.transport
    .addSampleToGraph(graph, {
      label: 'ray-diffuse.transport',
      buffers: new Map([[prepared.rays, rays]]),
      textures,
      // Iteration 2 produces one independent raw sample per frame. Temporal
      // accumulation belongs to the later reconstruction owner, never this buffer.
      reset: true,
    })
    .unwrap();
  const shared = {
    records,
    recordBytes: prepared.recordBytes,
    view,
    pixelCount: prepared.pixelCount,
  };
  let irradiance = accumulation;
  if (prepared.reconstruction !== undefined) {
    const reconstructed = addRayReconstructionPasses(
      graph,
      'ray-diffuse',
      prepared.reconstruction,
      accumulation,
      shared,
      target,
    );
    if (!reconstructed.ok) return reconstructed;
    irradiance = reconstructed.value;
  }
  const composited = graph.addRasterPass('ray-diffuse.composite', {
    accesses: [
      { resource: target.scene.view, usage: 'color-attachment' },
      { resource: irradiance, usage: 'storage-read' },
      { resource: target.depth, usage: 'sampled-read' },
      { resource: target.normal.view, usage: 'sampled-read' },
      { resource: target.albedo.view, usage: 'sampled-read' },
      { resource: target.f0.view, usage: 'sampled-read' },
      { resource: view, usage: 'uniform-read' },
    ],
    colorAttachments: [{ view: target.scene.view, loadOp: 'load', storeOp: 'store' }],
    encode: ({ pass, resources }) => {
      prepared.composite
        .record(
          pass,
          {
            irradiance: resources.buffer(irradiance).unwrap(),
            depth: resources.textureView(target.depth).unwrap(),
            normal: resources.textureView(target.normal.view).unwrap(),
            albedoMetallic: resources.textureView(target.albedo.view).unwrap(),
            f0Occlusion: resources.textureView(target.f0.view).unwrap(),
            view: { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
          },
          prepared.pixelCount,
        )
        .unwrap();
    },
  });
  if (!composited.ok || prepared.reflections === undefined || target.reflection === undefined)
    return composited;
  return addRayReflectionPasses(
    graph,
    prepared.reflections,
    { ...shared, textures, fence: prepared.fence, generation: prepared.generation },
    target,
    target.reflection,
  );
}
