import type {
  GraphBuffer,
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import type { Buffer, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RayDiffuseTargets } from './diffuse-graph';
import { DIFFUSE_HISTORY_BYTES } from './diffuse-reconstruction';
import type { PreparedRayDiffuse } from './renderer-diffuse';
import type { RendererDiffuseReconstruction } from './renderer-diffuse-reconstruction';

/** Per-frame graph handles every exact GI lane borrows from the diffuse owner. */
export interface RayGraphShared {
  readonly records: GraphBuffer;
  readonly recordBytes: number;
  readonly view: GraphBuffer;
  readonly pixelCount: number;
}

/** One graph address per resident material texture; both transports reuse it. */
export function importRayMaterialTextures(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  materials: PreparedRayDiffuse['textures'],
): Map<TextureView, GraphTextureView> {
  const textures = new Map<TextureView, GraphTextureView>();
  const allocations = new Map<Texture, GraphTexture>();
  for (const material of materials) {
    for (const resident of material.textures.values()) {
      if (textures.has(resident.view)) continue;
      const receipt = resident.receipt;
      if (receipt.view !== '2d') throw new Error('ray material expects a 2D resident texture');
      let allocation = allocations.get(resident.texture);
      if (allocation === undefined) {
        allocation = graph
          .importTexture(
            `ray-diffuse.material.${allocations.size}`,
            {
              format: receipt.format,
              size: receipt.extent,
              mipLevelCount: receipt.mipLevelCount,
              usage: 4,
            },
            () => resident.texture,
          )
          .unwrap();
        allocations.set(resident.texture, allocation);
      }
      textures.set(
        resident.view,
        graph
          .importView(
            allocation,
            { dimension: '2d', mipLevelCount: receipt.mipLevelCount },
            () => resident.view,
          )
          .unwrap(),
      );
    }
  }
  return textures;
}

/** Temporal (+ spatial) reconstruction of one raw 80-byte radiance accumulation. */
export function addRayReconstructionPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: 'ray-diffuse' | 'ray-reflection',
  reconstruction: RendererDiffuseReconstruction,
  accumulation: GraphBuffer,
  shared: RayGraphShared,
  target: Pick<RayDiffuseTargets, 'depth' | 'normal' | 'identity' | 'motion'>,
) {
  const { records, view, pixelCount } = shared;
  const imported = (name: string, size: number, usage: number, buffer: () => Buffer) =>
    graph.importBuffer(`${label}.${name}`, { size, usage }, buffer).unwrap();
  const previous = imported(
    'history.previous',
    pixelCount * DIFFUSE_HISTORY_BYTES,
    128 | 12,
    () => reconstruction.previous,
  );
  const current = imported(
    'history.current',
    pixelCount * DIFFUSE_HISTORY_BYTES,
    128 | 12,
    () => reconstruction.current,
  );
  const signal = imported('signal', pixelCount * 16, 128 | 12, () => reconstruction.signal);
  const diagnostics = imported(
    'diagnostics',
    pixelCount * 16,
    128 | 12,
    () => reconstruction.diagnostics,
  );
  const config = imported('reconstruction-config', 48, 64 | 8, () => reconstruction.config);
  for (const stage of reconstruction.mode === 'temporal'
    ? (['temporal'] as const)
    : (['temporal', 'spatial'] as const)) {
    const added = graph.addComputePass(`${label}.${stage}`, {
      accesses: [
        { resource: accumulation, usage: 'storage-read' },
        { resource: records, usage: 'storage-read' },
        { resource: previous, usage: 'storage-read' },
        { resource: current, usage: stage === 'temporal' ? 'storage-write' : 'storage-read' },
        { resource: signal, usage: 'storage-write' },
        { resource: diagnostics, usage: 'storage-write' },
        { resource: target.depth, usage: 'sampled-read' },
        { resource: target.normal.view, usage: 'sampled-read' },
        { resource: target.identity.view, usage: 'sampled-read' },
        { resource: target.motion.view, usage: 'sampled-read' },
        { resource: view, usage: 'uniform-read' },
        { resource: config, usage: 'uniform-read' },
      ],
      encode: ({ pass, resources }) =>
        reconstruction.kernel
          .record(
            pass,
            {
              raw: resources.buffer(accumulation).unwrap(),
              records: { buffer: resources.buffer(records).unwrap(), size: shared.recordBytes },
              previous: resources.buffer(previous).unwrap(),
              current: resources.buffer(current).unwrap(),
              signal: resources.buffer(signal).unwrap(),
              diagnostics: resources.buffer(diagnostics).unwrap(),
              depth: resources.textureView(target.depth).unwrap(),
              normal: resources.textureView(target.normal.view).unwrap(),
              identity: resources.textureView(target.identity.view).unwrap(),
              motion: resources.textureView(target.motion.view).unwrap(),
              view: { buffer: resources.buffer(view).unwrap(), size: VIEW_UNIFORM_BYTES },
              config: resources.buffer(config).unwrap(),
            },
            pixelCount,
            stage,
          )
          .unwrap(),
    });
    if (!added.ok) return added;
  }
  return ok(signal);
}
