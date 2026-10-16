import type { GraphTextureView, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { TextureView } from '@forgeax/engine-rhi';
import type { RendererGenerationFence } from '../assembly/renderer-frame-transaction';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RayDiffuseTargets } from './diffuse-graph';
import { RAY_PATH_STRIDE } from './path-tracer';
import { addRayReconstructionPasses, type RayGraphShared } from './ray-graph-shared';
import type { PreparedRayReflections } from './reflections-prepare';

/** Receiver rays -> world radiance -> optional denoise -> additive specular into scene
 * color and the SSR fallback, so SSR confidence replaces world specular instead of adding. */
export function addRayReflectionPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepared: PreparedRayReflections,
  shared: RayGraphShared & {
    readonly textures: ReadonlyMap<TextureView, GraphTextureView>;
    readonly fence: RendererGenerationFence;
    readonly generation: number;
  },
  target: RayDiffuseTargets,
  reflection: NonNullable<RayDiffuseTargets['reflection']>,
) {
  const { records, view, pixelCount } = shared;
  const rays = graph
    .importBuffer(
      'ray-reflection.initial-rays',
      { size: pixelCount * RAY_PATH_STRIDE, usage: 128 | 8 },
      () => prepared.rays,
    )
    .unwrap();
  const sample = graph
    .importBuffer('ray-reflection.sample', { size: 16, usage: 64 | 8 }, () => prepared.sample)
    .unwrap();
  const generated = graph.addComputePass('ray-reflection.generate', {
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
      if (shared.fence.currentGeneration() !== shared.generation)
        throw new Error('stale Lite reflections graph; prepare the current scene');
      prepared.writeSample();
      prepared.generate
        .record(
          pass,
          {
            depth: resources.textureView(target.depth).unwrap(),
            normal: resources.textureView(target.normal.view).unwrap(),
            identity: resources.textureView(target.identity.view).unwrap(),
            records: { buffer: resources.buffer(records).unwrap(), size: shared.recordBytes },
            view: { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
            sample: resources.buffer(sample).unwrap(),
            rays: resources.buffer(rays).unwrap(),
          },
          pixelCount,
        )
        .unwrap();
    },
  });
  if (!generated.ok) return generated;
  const raw = prepared.transport
    .addSampleToGraph(graph, {
      label: 'ray-reflection.transport',
      buffers: new Map([[prepared.rays, rays]]),
      textures: shared.textures,
      reset: true,
    })
    .unwrap();
  let reconstructed: typeof raw | undefined;
  if (prepared.reconstruction !== undefined) {
    const added = addRayReconstructionPasses(
      graph,
      'ray-reflection',
      prepared.reconstruction,
      raw,
      shared,
      target,
    );
    if (!added.ok) return added;
    reconstructed = added.value;
  }
  return graph.addRasterPass('ray-reflection.composite', {
    accesses: [
      { resource: target.scene.view, usage: 'color-attachment' },
      { resource: reflection.fallback.view, usage: 'color-attachment' },
      { resource: raw, usage: 'storage-read' },
      ...(reconstructed === undefined
        ? []
        : [{ resource: reconstructed, usage: 'storage-read' as const }]),
      { resource: target.depth, usage: 'sampled-read' },
      { resource: target.normal.view, usage: 'sampled-read' },
      { resource: reflection.response.view, usage: 'sampled-read' },
    ],
    colorAttachments: [
      { view: target.scene.view, loadOp: 'load', storeOp: 'store' },
      { view: reflection.fallback.view, loadOp: 'load', storeOp: 'store' },
    ],
    encode: ({ pass, resources }) => {
      prepared.composite
        .record(
          pass,
          {
            accumulation: resources.buffer(raw).unwrap(),
            ...(reconstructed === undefined
              ? {}
              : { reconstructed: resources.buffer(reconstructed).unwrap() }),
            depth: resources.textureView(target.depth).unwrap(),
            normal: resources.textureView(target.normal.view).unwrap(),
            response: resources.textureView(reflection.response.view).unwrap(),
          },
          pixelCount,
        )
        .unwrap();
    },
  });
}
