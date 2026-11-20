import {
  type BindGroupLayout,
  err,
  ok,
  type RenderPipeline,
  type Result,
  type RhiCommandEncoder,
  type RhiDevice,
  RhiError,
  type Sampler,
  type Texture,
} from '@forgeax/engine-rhi';
import { mipDimension } from '@forgeax/engine-types';
import type { MipmapShaderModuleFactory, MipmapTextureDescriptor } from './mipmap-generator.js';

/** RGB stores an encoded unit normal at level zero. Generated RGB retains the
 * mean normal; alpha stores a perceptual roughness floor derived from its length.
 * The consumer combines alpha^4 with authored roughness^4. Base alpha is zero.
 * Mean vectors stay in transient half-float images between levels: repeatedly
 * normalizing or decoding RGBA8 intermediates loses variance or adds false variance.
 */
const FILTER_WGSL = `
struct Vertex { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> Vertex {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return Vertex(vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0), p * vec2<f32>(1.0, -1.0) + vec2<f32>(0.0, 1.0));
}
@group(0) @binding(0) var imageSampler: sampler;
@group(0) @binding(1) var image: texture_2d<f32>;
struct Filtered { @location(0) packed: vec4<f32>, @location(1) mean: vec4<f32> };
fn unitNormal(p: vec2<i32>) -> vec3<f32> {
  let size = vec2<i32>(textureDimensions(image));
  let n = textureLoad(image, clamp(p, vec2<i32>(0), size - 1), 0).xyz * 2.0 - 1.0;
  return n / max(length(n), 0.0001);
}
fn result(mean: vec3<f32>) -> Filtered {
  // Half-float normalization/storage roundoff must not roughen a constant
  // tilted normal. This floor bounds the numerical dead zone, not the model.
  let variance = max(1.0 - length(mean) - 0.001, 0.0) / max(length(mean), 0.0001);
  let roughness = pow(min(variance, 1.0), 0.25);
  return Filtered(vec4<f32>(mean * 0.5 + 0.5, roughness), vec4<f32>(mean, 0.0));
}
@fragment fn fs_base(in: Vertex) -> Filtered {
  let p = in.uv * vec2<f32>(textureDimensions(image)) - 0.5;
  let q = vec2<i32>(floor(p)); let f = fract(p);
  return result(mix(mix(unitNormal(q), unitNormal(q + vec2<i32>(1, 0)), f.x),
    mix(unitNormal(q + vec2<i32>(0, 1)), unitNormal(q + vec2<i32>(1, 1)), f.x), f.y));
}
@fragment fn fs_mean(in: Vertex) -> Filtered {
  return result(textureSample(image, imageSampler, in.uv).xyz);
}
`;

export interface NormalRoughnessMipmapPipelines {
  readonly base: RenderPipeline;
  readonly mean: RenderPipeline;
}

export async function prepareNormalRoughnessMipmapPipelines(
  device: RhiDevice,
  layout: BindGroupLayout,
  factory: MipmapShaderModuleFactory,
): Promise<Result<NormalRoughnessMipmapPipelines, RhiError>> {
  const module = await factory(device, { code: FILTER_WGSL, label: 'normal-roughness-mips' });
  if (!module.ok) return module;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const create = (entryPoint: string) =>
    device.createRenderPipeline({
      label: `normal-roughness-${entryPoint}`,
      layout: pipelineLayout.value,
      vertex: { module: module.value, entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module: module.value,
        entryPoint,
        targets: [{ format: 'rgba8unorm' }, { format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
  const base = create('fs_base');
  if (!base.ok) return base;
  const mean = create('fs_mean');
  return mean.ok ? ok({ base: base.value, mean: mean.value }) : mean;
}

/** One submission-owned setup transaction. No readback or persistent CPU pixels. */
export function encodeNormalRoughnessMipmaps(
  device: RhiDevice,
  encoder: RhiCommandEncoder,
  texture: Texture,
  descriptor: MipmapTextureDescriptor,
  levels: number,
  cache: { readonly layout: BindGroupLayout; readonly sampler: Sampler },
  pipelines: NormalRoughnessMipmapPipelines,
  images: Texture[],
): Result<void, RhiError> {
  const layers = descriptor.arrayLayerCount ?? 1;
  if (!Number.isSafeInteger(layers) || layers < 1)
    return err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'positive mip array layer count',
        hint: 'use the declared texture layer count',
      }),
    );
  const physical = device.caps.backendKind === 'wgpu-webgl2';
  const create = (mip: number, format: GPUTextureFormat) => {
    const image = device.createTexture({
      label: `normal-roughness-scratch-${mip}`,
      size: [mipDimension(descriptor.width, mip), mipDimension(descriptor.height, mip)],
      format,
      usage: 1 | 2 | 4 | 16,
      mipLevelCount: 1,
    });
    if (image.ok) images.push(image.value);
    return image;
  };
  // Reuse the same physical chain for every array layer. The first GL pass
  // stages its base/output to avoid sampling an attached physical texture.
  const means: Texture[] = [];
  for (let mip = 1; mip < levels; mip++) {
    const image = create(mip, 'rgba16float');
    if (!image.ok) return image;
    means.push(image.value);
  }
  const base = physical && layers > 1 ? create(0, 'rgba8unorm') : ok(texture);
  if (!base.ok) return base;
  const first = physical ? create(1, 'rgba8unorm') : undefined;
  if (first !== undefined && !first.ok) return first;
  const encodeLevel = (
    previous: Texture,
    mip: number,
    layer: number,
  ): Result<Texture, RhiError> => {
    const mean = means[mip - 1];
    if (mean === undefined) throw new Error('Missing prepared normal mip mean');
    const source = device.createTextureView(previous, {
      dimension: '2d',
      ...(previous === texture
        ? { baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 }
        : {}),
    });
    if (!source.ok) return source;
    const staged = mip === 1 && first?.ok === true;
    const target = device.createTextureView(staged ? first.value : texture, {
      dimension: '2d',
      ...(staged
        ? {}
        : { baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 }),
    });
    if (!target.ok) return target;
    const meanView = device.createTextureView(mean, { dimension: '2d' });
    if (!meanView.ok) return meanView;
    const group = device.createBindGroup({
      layout: cache.layout,
      entries: [
        { binding: 0, resource: { kind: 'sampler', value: cache.sampler } },
        { binding: 1, resource: { kind: 'textureView', value: source.value } },
      ],
    });
    if (!group.ok) return group;
    const pass = encoder.beginRenderPass({
      label: `normal-roughness-mip-${layer}-${mip}`,
      colorAttachments: [target.value, meanView.value].map((view) => ({
        view,
        loadOp: 'clear' as const,
        storeOp: 'store' as const,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      })),
    });
    pass.setPipeline(mip === 1 ? pipelines.base : pipelines.mean);
    pass.setBindGroup(0, group.value);
    pass.draw(3, 1, 0, 0);
    pass.end();
    if (staged)
      encoder.copyTextureToTexture(
        { texture: first.value },
        { texture, mipLevel: mip, origin: { x: 0, y: 0, z: layer } },
        [mipDimension(descriptor.width, mip), mipDimension(descriptor.height, mip), 1],
      );
    return ok(mean);
  };
  for (let layer = 0; layer < layers; layer++) {
    if (base.value !== texture)
      encoder.copyTextureToTexture(
        { texture, origin: { x: 0, y: 0, z: layer } },
        { texture: base.value },
        [descriptor.width, descriptor.height, 1],
      );
    let previous = base.value;
    for (let mip = 1; mip < levels; mip++) {
      const encoded = encodeLevel(previous, mip, layer);
      if (!encoded.ok) return encoded;
      previous = encoded.value;
    }
  }
  return ok(undefined);
}
