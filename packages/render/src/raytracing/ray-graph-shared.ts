import type {
  GraphBuffer,
  GraphTexture,
  GraphTextureDescriptor,
  GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import type { Buffer, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { computeBindGroup } from '../compute-graph-state';
import { createRasterState, type RasterState } from '../raster-graph-state';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../render-pipeline';
import type { createRayDiffuseComposite } from './diffuse-composite';
import type { ExactRayDiffuseTargets, RayDiffuseTargets } from './diffuse-graph';
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

const RAY_RECEIVER_NORMAL_WGSL = `
@group(0) @binding(0) var normals: texture_2d<u32>;
@group(0) @binding(1) var materials: texture_2d<u32>;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32(index & 1u) * 2.0, f32(index & 2u));
  return vec4f(xy * vec2f(2, -2) + vec2f(-1, 1), 0, 1);
}

@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec2u {
  let pixel = vec2i(position.xy);
  let b = textureLoad(materials, pixel, 0).r;
  let model = (b >> 24u) & 15u;
  if (model == 0u) { return vec2u(0u); }
  let a = textureLoad(normals, pixel, 0).r;
  // Transport keeps its normal, validity and roughness in one texel.
  // Standard-G-buffer/4 model 5 carries subsurface and model 6 carries two-sided diffuse.
  let classified = model == 1u || model == 5u || model == 6u;
  let backfaceDiffuse = model == 5u || model == 6u;
  let flags = select(0u, 0x10000u, classified) | select(0u, 0x20000u, backfaceDiffuse);
  return vec2u((a & 0x3fffffffu) | 0x40000000u, ((b >> 16u) & 255u) | flags);
}
`;

/** Exact, cached and screen-probe transport share this on-demand receiver guide. */
export function addRayReceiverNormalProjection(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  normal: GraphTextureView,
  material: GraphTextureView,
  size: GraphTextureDescriptor['size'],
) {
  const label = 'ray-receiver-normal';
  const target = createRenderPipelineTarget(graph, label, { format: 'rg32uint', size });
  if (!target.ok) return target;
  const output = target.value;
  let state: RasterState | undefined;
  const added = graph.addRasterPass(label, {
    accesses: [
      { resource: normal, usage: 'sampled-read' },
      { resource: material, usage: 'sampled-read' },
      { resource: output.view, usage: 'color-attachment' },
    ],
    colorAttachments: [{ view: output.view, loadOp: 'clear', storeOp: 'store' }],
    encodeDirect(pass, frame, resources) {
      state ??= createRasterState(
        frame,
        RAY_RECEIVER_NORMAL_WGSL,
        label,
        [0, 1].map((binding) => ({ binding, visibility: 2, texture: { sampleType: 'uint' } })),
        'vs_main',
        'fs_main',
        [output.format],
      );
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(
        0,
        computeBindGroup(
          frame,
          state,
          [normal, material].map((view, binding) => ({
            binding,
            resource: { kind: 'textureView', value: resources.textureView(view).unwrap() },
          })),
        ),
      );
      pass.draw(3);
    },
  });
  return added.ok ? target : added;
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
  target: Pick<ExactRayDiffuseTargets, 'depth' | 'normal' | 'identity' | 'motion'>,
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
      encodeDirect: (pass, _graphframe, resources) =>
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

/** All diffuse lanes compose their current signal into the same HDR attachments. */
export function addRayDiffuseCompositePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  name: string,
  current: () => Extract<
    Awaited<ReturnType<typeof createRayDiffuseComposite>>,
    { ok: true }
  >['value'],
  target: RayDiffuseTargets,
  irradiance: GraphBuffer,
  pixelCount: number,
) {
  const { diffuseGiBaseline: baseline, subsurfaceDiffuse: subsurface } = target;
  return graph.addRasterPass(name, {
    accesses: [
      { resource: target.scene.view, usage: 'color-attachment' },
      { resource: baseline, usage: 'storage-read' },
      ...(subsurface === undefined
        ? []
        : [{ resource: subsurface.view, usage: 'color-attachment' as const }]),
      { resource: irradiance, usage: 'storage-read' },
      { resource: target.depth, usage: 'sampled-read' },
      { resource: target.normal.view, usage: 'sampled-read' },
    ],
    colorAttachments: [
      { view: target.scene.view, loadOp: 'load', storeOp: 'store' },
      ...(subsurface === undefined
        ? []
        : [{ view: subsurface.view, loadOp: 'load' as const, storeOp: 'store' as const }]),
    ],
    encodeDirect: (pass, _graphframe, resources) =>
      current()
        .record(
          pass,
          {
            irradiance: resources.buffer(irradiance).unwrap(),
            baseline: resources.buffer(baseline).unwrap(),
            subsurface: subsurface !== undefined,
            depth: resources.textureView(target.depth).unwrap(),
            normal: resources.textureView(target.normal.view).unwrap(),
          },
          pixelCount,
        )
        .unwrap(),
  });
}

/** Borrow the directional fallback before the full-screen pass replaces it. */
export function snapshotRayReflectionFallback(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  name: string,
  source: RenderPipelineTarget,
) {
  const texture = graph.createTextureLike(name, source.texture);
  if (!texture.ok) return texture;
  const view = graph.view(texture.value);
  if (!view.ok) return view;
  const copy = graph.addCopyPass(`${name}.copy`, {
    accesses: [
      { resource: source.view, usage: 'copy-src' },
      { resource: view.value, usage: 'copy-dst' },
    ],
    encodeDirect(encoder, _frame, resources) {
      encoder.copyTextureToTexture(
        { texture: resources.texture(source.texture).unwrap() },
        { texture: resources.texture(texture.value).unwrap() },
        { ...resources.textureViewExtent(source.view).unwrap(), depthOrArrayLayers: 1 },
      );
    },
  });
  return copy.ok ? view : copy;
}
