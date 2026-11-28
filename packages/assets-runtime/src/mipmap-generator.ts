// Per-device, per-format mip pipelines. Shader compilation is injected from the
// selected backend; recording and submission use the shared RHI contract.

import {
  type BindGroupLayout,
  type CommandBuffer,
  err,
  ok,
  type PipelineLayout,
  type RenderPipeline,
  type Result,
  type RhiCommandEncoder,
  type RhiDevice,
  RhiError,
  type RhiRenderPassEncoder,
  type Sampler,
  type ShaderModule,
  type Texture,
  type TextureView,
} from '@forgeax/engine-rhi';
import {
  type GpuTextureMipFilter,
  mipDimension,
  numMipLevels,
  textureFormatBlock,
} from '@forgeax/engine-types';

import {
  encodeNormalRoughnessMipmaps,
  type NormalRoughnessMipmapPipelines,
  prepareNormalRoughnessMipmapPipelines,
} from './normal-roughness-mips.js';

/** Inject the backend's async shader compiler without importing its implementation. */
export type MipmapShaderModuleFactory = (
  device: RhiDevice,
  desc: { code: string; label?: string },
) => Promise<Result<ShaderModule, RhiError>>;

export type NativeMipmapShaderCompiler = (
  device: RhiDevice,
  desc: { code: string; label?: string },
) => Result<ShaderModule, RhiError>;

type MipmapPipelineKey = `${GPUTextureFormat}/${string}`;

/**
 * Per-device pipeline cache structure (research F-2 SSOT).
 * The device owns the one module and layout shared by all admitted formats.
 */
interface MipmapPipelineCache {
  readonly sampler: Sampler;
  readonly module: ShaderModule;
  readonly layout: BindGroupLayout;
  pipelineLayout?: PipelineLayout;
  readonly pipelines: Map<MipmapPipelineKey, RenderPipeline>;
  normalRoughness?: NormalRoughnessMipmapPipelines;
  normalRoughnessPreparation?: Promise<Result<NormalRoughnessMipmapPipelines, RhiError>>;
}

interface MipmapDevice {
  immediate?: NativeMipmapShaderCompiler;
  cache?: MipmapPipelineCache;
  preparation?: Promise<Result<MipmapPipelineCache, RhiError>>;
}

const mipmapDevices = new WeakMap<RhiDevice, MipmapDevice>();

function mipmapDevice(device: RhiDevice): MipmapDevice {
  let state = mipmapDevices.get(device);
  if (state === undefined) {
    state = {};
    mipmapDevices.set(device, state);
  }
  return state;
}

/** Bind the native compiler without preparing any shader or pipeline. */
export function configureNativeMipmapCompiler(
  device: RhiDevice,
  compile: NativeMipmapShaderCompiler,
): void {
  if (device.caps.backendKind === 'webgpu') mipmapDevice(device).immediate = compile;
}

/** Whether a single box-filter level can resolve a pipeline while recording. */
export function canEncodeMipmapLevel(device: RhiDevice, format: GPUTextureFormat): boolean {
  const state = mipmapDevices.get(device);
  return (
    state?.immediate !== undefined ||
    (state?.cache?.pipelines.has(mipmapPipelineKey(format)) ?? false)
  );
}

/**
 * Oversized-triangle WGSL (toji + greggman convergent template).
 *
 * Vertex stage emits a single triangle covering the entire NDC, and texCoord
 * is computed from clip-space position via `pos * vec2(0.5, -0.5) +
 * vec2(0.5)` (NDC -> UV with Y-flip in one fused MAD; saves a 6-vertex quad).
 *
 * Fragment stage samples the bound `texture_2d<f32>` with the linear /
 * linear / linear sampler -- bilinear when the source mip is read by the
 * destination mip, automatic sRGB decode / encode happens in the spec when
 * source AND destination views are the SAME `*-srgb` format (research F-3).
 */
const MIPMAP_WGSL = `
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0)       uv   : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VsOut {
  // 3 vertices forming an oversized triangle: (-1,-1), (-1,3), (3,-1)
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(-1.0,  3.0),
    vec2<f32>( 3.0, -1.0),
  );
  let pos = positions[vid];
  var out : VsOut;
  out.clip = vec4<f32>(pos, 0.0, 1.0);
  // NDC -> UV with Y-flip fused into a single MAD.
  out.uv = pos * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  return out;
}

@group(0) @binding(0) var src_sampler : sampler;
@group(0) @binding(1) var src_texture : texture_2d<f32>;

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  return textureSample(src_texture, src_sampler, in.uv);
}

fn gaussian(uv: vec2<f32>, texel: vec2<f32>) -> vec4<f32> {
  // Pair neighboring weights of the separable [1, 3, 3, 1] kernel.
  let d = texel * 0.75;
  return 0.25 * (
    textureSampleLevel(src_texture, src_sampler, uv + vec2<f32>(-d.x, -d.y), 0.0) +
    textureSampleLevel(src_texture, src_sampler, uv + vec2<f32>( d.x, -d.y), 0.0) +
    textureSampleLevel(src_texture, src_sampler, uv + vec2<f32>(-d.x,  d.y), 0.0) +
    textureSampleLevel(src_texture, src_sampler, uv + vec2<f32>( d.x,  d.y), 0.0)
  );
}

@fragment
fn fs_gaussian(in: VsOut) -> @location(0) vec4<f32> {
  return gaussian(in.uv, 1.0 / vec2<f32>(textureDimensions(src_texture)));
}

override sharpenStrength: f32 = 0.0;

@fragment
fn fs_sharpen(in: VsOut) -> @location(0) vec4<f32> {
  let texel = 1.0 / vec2<f32>(textureDimensions(src_texture));
  let narrow = gaussian(in.uv, texel);
  // Pair the eight binomial taps along each axis. Sharpen luminance only.
  let offsets = vec4<f32>(-2.625, -0.875, 0.875, 2.625);
  let weights = vec4<f32>(0.0625, 0.4375, 0.4375, 0.0625);
  let luma = vec3<f32>(0.2126, 0.7152, 0.0722);
  var broadLuma = 0.0;
  for (var y = 0u; y < 4u; y++) {
    for (var x = 0u; x < 4u; x++) {
      let uv = in.uv + vec2<f32>(offsets[x], offsets[y]) * texel;
      broadLuma += dot(textureSampleLevel(src_texture, src_sampler, uv, 0.0).rgb, luma)
        * weights[x] * weights[y];
    }
  }
  let delta = (dot(narrow.rgb, luma) - broadLuma) * sharpenStrength;
  return vec4<f32>(narrow.rgb + vec3<f32>(delta), narrow.a);
}
`;

/**
 * Number of cached pipelines for the device (introspection hook used by
 * T-M3-01 (c) cache-hit / (d) per-device-isolation tests; charter P3
 * explicit failure: a cache size of 0 on a fresh device is a witnessed
 * pre-condition rather than a swept-under hint).
 */
export function mipmapCacheSize(device: RhiDevice): number {
  const cache = mipmapDevices.get(device)?.cache;
  return (cache?.pipelines.size ?? 0) + (cache?.normalRoughness === undefined ? 0 : 2);
}

/**
 * Get the existing per-format render pipeline or build a fresh one.
 *
 * Per-device WeakMap + per-format `Map<GPUTextureFormat, RenderPipeline>`
 * (greggman 36-44 + 119-122). The shared sampler / shader-module /
 * bind-group-layout are constructed lazily on the first cache miss for a
 * given device and reused across all formats on that device.
 */
function mipmapPipelineKey(
  format: GPUTextureFormat,
  filter: GpuTextureMipFilter = 'box',
): MipmapPipelineKey {
  return `${format}/${typeof filter === 'string' ? filter : `sharpen-${filter.strength}`}`;
}

export async function getOrCreateMipmapPipeline(
  device: RhiDevice,
  format: GPUTextureFormat,
  asyncCreateShaderModule: MipmapShaderModuleFactory,
  filter: GpuTextureMipFilter = 'box',
): Promise<Result<RenderPipeline, RhiError>> {
  const cache = await ensureDeviceCache(device, mipmapDevice(device), asyncCreateShaderModule);
  if (!cache.ok) return cache;
  if (filter === 'normal-roughness') {
    if (format !== 'rgba8unorm')
      return err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'linear RGBA8 normal-roughness mips',
          hint: 'declare a generated rgba8unorm normal output',
        }),
      );
    const state = cache.value;
    if (state.normalRoughness !== undefined) return ok(state.normalRoughness.base);
    state.normalRoughnessPreparation ??= prepareNormalRoughnessMipmapPipelines(
      device,
      state.layout,
      asyncCreateShaderModule,
    )
      .then((result) => {
        if (result.ok) state.normalRoughness = result.value;
        return result;
      })
      .finally(() => {
        delete state.normalRoughnessPreparation;
      });
    const prepared = await state.normalRoughnessPreparation;
    return prepared.ok ? ok(prepared.value.base) : prepared;
  }
  if (
    typeof filter === 'object' &&
    (!Number.isInteger(filter.strength) || filter.strength < 0 || filter.strength > 10)
  )
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'integer mip sharpening strength in [0, 10]',
        hint: 'use 0 for Gaussian or select a bounded sharpening strength',
      }),
    );
  if (device.caps.backendKind === 'wgpu-webgl2' && filter !== 'box') {
    const stage = await getOrCreateMipmapPipeline(device, format, asyncCreateShaderModule);
    if (!stage.ok) return stage;
  }
  return mipmapPipeline(device, cache.value, format, filter);
}

function mipmapPipeline(
  device: RhiDevice,
  cache: MipmapPipelineCache,
  format: GPUTextureFormat,
  filter: GpuTextureMipFilter,
): Result<RenderPipeline, RhiError> {
  const key = mipmapPipelineKey(format, filter);
  const existing = cache.pipelines.get(key);
  if (existing !== undefined) return ok(existing);
  if (cache.pipelineLayout === undefined) {
    const layout = device.createPipelineLayout({
      label: 'mipmap-pl',
      bindGroupLayouts: [cache.layout],
    });
    if (!layout.ok) return layout;
    cache.pipelineLayout = layout.value;
  }
  const pipelineRes = device.createRenderPipeline({
    label: `mipmap-pipeline-${key}`,
    layout: cache.pipelineLayout,
    vertex: { module: cache.module, entryPoint: 'vs_main', buffers: [] },
    fragment: {
      module: cache.module,
      ...(typeof filter === 'object' && filter.strength > 0
        ? { entryPoint: 'fs_sharpen', constants: { sharpenStrength: filter.strength / 10 } }
        : { entryPoint: filter === 'box' ? 'fs_main' : 'fs_gaussian' }),
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list' },
  });
  if (!pipelineRes.ok) return pipelineRes;
  cache.pipelines.set(key, pipelineRes.value);
  return pipelineRes;
}

const MIPMAP_MODULE = { code: MIPMAP_WGSL, label: 'mipmap-wgsl' } as const;

async function ensureDeviceCache(
  device: RhiDevice,
  state: MipmapDevice,
  asyncCreateShaderModule: MipmapShaderModuleFactory,
): Promise<Result<MipmapPipelineCache, RhiError>> {
  if (state.cache !== undefined) return ok(state.cache);
  if (state.immediate !== undefined) return buildNativeDeviceCache(device, state, state.immediate);
  state.preparation ??= Promise.resolve()
    .then(() => asyncCreateShaderModule(device, MIPMAP_MODULE))
    .then((result) => {
      if (state.cache !== undefined) return ok(state.cache);
      return result.ok ? installDeviceCache(device, state, result.value) : result;
    })
    .finally(() => {
      delete state.preparation;
    });
  return state.preparation;
}

function buildNativeDeviceCache(
  device: RhiDevice,
  state: MipmapDevice,
  compile: NativeMipmapShaderCompiler,
): Result<MipmapPipelineCache, RhiError> {
  const result = compile(device, MIPMAP_MODULE);
  return result.ok ? installDeviceCache(device, state, result.value) : result;
}

function prepareNativeBoxPipeline(
  device: RhiDevice,
  state: MipmapDevice | undefined,
  format: GPUTextureFormat,
): Result<RenderPipeline, RhiError> | undefined {
  const compile = state?.immediate;
  if (state === undefined || compile === undefined) return undefined;
  if (state.cache !== undefined) return mipmapPipeline(device, state.cache, format, 'box');
  const result = buildNativeDeviceCache(device, state, compile);
  return result.ok ? mipmapPipeline(device, result.value, format, 'box') : result;
}

function installDeviceCache(
  device: RhiDevice,
  state: MipmapDevice,
  module: ShaderModule,
): Result<MipmapPipelineCache, RhiError> {
  if (state.cache !== undefined) return ok(state.cache);
  const samplerRes = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    ...(device.caps.backendKind === 'wgpu-webgl2' ? { lodMaxClamp: 0 } : {}),
  });
  if (!samplerRes.ok) return samplerRes;

  // GPUShaderStage.FRAGMENT = 0x2 spec constant; embedded literally to keep
  // the utility math-free (charter F2 minimal surface; spec value is stable).
  const FRAGMENT_STAGE = 0x2;
  const layoutRes = device.createBindGroupLayout({
    label: 'mipmap-bgl',
    entries: [
      { binding: 0, visibility: FRAGMENT_STAGE, sampler: { type: 'filtering' } },
      {
        binding: 1,
        visibility: FRAGMENT_STAGE,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
    ],
  });
  if (!layoutRes.ok) return layoutRes;

  state.cache = {
    sampler: samplerRes.value,
    module,
    layout: layoutRes.value,
    pipelines: new Map(),
  };
  return ok(state.cache);
}

// COPY_SRC | RENDER_ATTACHMENT.
const MIPMAP_SCRATCH_USAGE = 0x01 | 0x10;

export interface MipmapTextureDescriptor {
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  /** Layers of a 2D array or cube texture; ordinary 2D textures default to one. */
  readonly arrayLayerCount?: number;
  readonly levels?: number;
  readonly filter?: GpuTextureMipFilter;
}

/** Peak setup storage, shared across array layers and released at the submit fence. */
export function mipmapTemporaryByteLength(
  descriptor: MipmapTextureDescriptor,
  backend: RhiDevice['caps']['backendKind'],
): number {
  const levels = descriptor.levels ?? numMipLevels(descriptor);
  if (levels <= 1) return 0;
  const physical = backend === 'wgpu-webgl2';
  const pixels = (level: number) =>
    mipDimension(descriptor.width, level) * mipDimension(descriptor.height, level);
  if (descriptor.filter === 'normal-roughness') {
    let bytes = 0;
    for (let level = 1; level < levels; level++) bytes += pixels(level) * 8;
    return (
      bytes +
      (physical ? pixels(1) * 4 + ((descriptor.arrayLayerCount ?? 1) > 1 ? pixels(0) * 4 : 0) : 0)
    );
  }
  if (!physical) return 0;
  const block = textureFormatBlock(descriptor.format);
  let bytes = 0;
  for (let level = 0; level < levels; level++)
    bytes +=
      Math.ceil(mipDimension(descriptor.width, level) / block.blockWidth) *
      Math.ceil(mipDimension(descriptor.height, level) / block.blockHeight) *
      block.bytesPerBlock;
  return bytes;
}

// Native subresource views read mip i-1 and write disjoint mip i of the
// same array layer directly. WebGL2 retains its separate physical chain:
// mip/layer views alias texture state and cannot share this direct path.
function encodeMipmapBlit(
  device: RhiDevice,
  encoder: RhiCommandEncoder,
  texture: Texture,
  descriptor: MipmapTextureDescriptor,
  levels: number,
  pipeline: RenderPipeline,
  cache: MipmapPipelineCache,
  transient: Texture[],
): Result<void, RhiError> {
  const arrayLayerCount = descriptor.arrayLayerCount ?? 1;
  if (!Number.isSafeInteger(arrayLayerCount) || arrayLayerCount < 1)
    return err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'mipmap arrayLayerCount is a positive integer',
        hint: 'provide the number of layers in the target 2D or cube texture',
      }),
    );
  if (device.caps.backendKind === 'wgpu-webgl2')
    return encodePhysicalMipmapChain(
      device,
      encoder,
      texture,
      descriptor,
      levels,
      pipeline,
      cache,
      transient,
    );
  for (let layer = 0; layer < arrayLayerCount; layer++) {
    for (let i = 1; i < levels; i++) {
      const srcViewRes = device.createTextureView(texture, {
        baseMipLevel: i - 1,
        mipLevelCount: 1,
        baseArrayLayer: layer,
        arrayLayerCount: 1,
        dimension: '2d',
      });
      if (!srcViewRes.ok) return srcViewRes;

      const dstViewRes = device.createTextureView(texture, {
        baseMipLevel: i,
        mipLevelCount: 1,
        baseArrayLayer: layer,
        arrayLayerCount: 1,
        dimension: '2d',
      });
      if (!dstViewRes.ok) return dstViewRes;

      const bindGroupRes = device.createBindGroup({
        label: `mipmap-bg-${i}`,
        layout: cache.layout,
        entries: [
          { binding: 0, resource: { kind: 'sampler', value: cache.sampler } },
          { binding: 1, resource: { kind: 'textureView', value: srcViewRes.value } },
        ],
      });
      if (!bindGroupRes.ok) return bindGroupRes;

      const pass = encoder.beginRenderPass({
        label: `mipmap-pass-${i}`,
        colorAttachments: [
          {
            view: dstViewRes.value,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroupRes.value);
      pass.draw(3, 1, 0, 0);
      pass.end();
    }
  }

  return ok(undefined);
}

/** GLES mip views share mutable base/max levels with the physical texture.
 * Read the full uploaded view at LOD zero and copy generated levels back
 * from physical, single-level images. One chain serves every array layer. */
function encodePhysicalMipmapChain(
  device: RhiDevice,
  encoder: RhiCommandEncoder,
  texture: Texture,
  descriptor: MipmapTextureDescriptor,
  levels: number,
  pipeline: RenderPipeline,
  cache: MipmapPipelineCache,
  transient: Texture[],
): Result<void, RhiError> {
  const stage = cache.pipelines.get(mipmapPipelineKey(descriptor.format));
  if (stage === undefined)
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'an identity blit pipeline for staging the base mip',
        hint: 'prewarm the mipmap pipeline before recording the physical chain',
      }),
    );
  const images = transient;
  for (let mip = 0; mip < levels; mip++) {
    const image = device.createTexture({
      label: `mipmap-physical-${mip}`,
      size: [mipDimension(descriptor.width, mip), mipDimension(descriptor.height, mip)],
      mipLevelCount: 1,
      format: descriptor.format,
      usage: MIPMAP_SCRATCH_USAGE | 0x02 | 0x04,
    });
    if (!image.ok) return err(image.error);
    images.push(image.value);
  }
  const first = images[0];
  if (first === undefined) return ok(undefined);
  const layers = descriptor.arrayLayerCount ?? 1;
  for (let layer = 0; layer < layers; layer++) {
    let previous = layers > 1 ? first : texture;
    // Array layers already require COPY_SRC for physical 2D staging. Ordinary
    // 2D inputs retain their TEXTURE_BINDING | COPY_DST usage contract.
    if (layers > 1)
      encoder.copyTextureToTexture(
        { texture, origin: { x: 0, y: 0, z: layer } },
        { texture: first },
        [descriptor.width, descriptor.height, 1],
      );
    for (const [mip, image] of images.entries()) {
      if (mip === 0 && layers > 1) continue;
      const source = device.createTextureView(previous, { dimension: '2d' });
      if (!source.ok) return err(source.error);
      const target = device.createTextureView(image, { dimension: '2d' });
      if (!target.ok) return err(target.error);
      const group = device.createBindGroup({
        label: `mipmap-physical-bg-${mip}`,
        layout: cache.layout,
        entries: [
          { binding: 0, resource: { kind: 'sampler', value: cache.sampler } },
          { binding: 1, resource: { kind: 'textureView', value: source.value } },
        ],
      });
      if (!group.ok) return err(group.error);
      const pass = encoder.beginRenderPass({
        label: `mipmap-physical-pass-${mip}`,
        colorAttachments: [
          {
            view: target.value,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(mip === 0 ? stage : pipeline);
      pass.setBindGroup(0, group.value);
      pass.draw(3, 1, 0, 0);
      pass.end();
      if (mip > 0)
        encoder.copyTextureToTexture(
          { texture: image },
          { texture, mipLevel: mip, origin: { x: 0, y: 0, z: layer } },
          [mipDimension(descriptor.width, mip), mipDimension(descriptor.height, mip), 1],
        );
      previous = image;
    }
  }
  return ok(undefined);
}

/**
 * A caller-owned mip transaction. Preparation records render passes into one
 * encoder but never finishes or submits it; the recovery owner decides when
 * the setup command buffer crosses its candidate generation boundary.
 */
export interface MipmapEncoderWork {
  readonly finish: () => Result<CommandBuffer | undefined, RhiError>;
  /**
   * Close unsubmitted encoder work and release its backend-owned temporary textures.
   * Call once after the finished buffer is submitted or the transaction aborts.
   */
  readonly discard: () => void;
}

/** Record into the submission owner's encoder; release backend temporaries after submission or abort. */
export function encodeMipmaps(
  device: RhiDevice,
  encoder: RhiCommandEncoder,
  texture: Texture,
  descriptor: MipmapTextureDescriptor,
  capture?: (release: () => void) => void,
): Result<() => void, RhiError> {
  const levels = descriptor.levels ?? numMipLevels(descriptor);
  if (levels <= 1) {
    const release = () => {};
    capture?.(release);
    return ok(release);
  }
  const state = mipmapDevices.get(device);
  let cache = state?.cache;
  const normal = descriptor.filter === 'normal-roughness';
  let pipeline = normal
    ? cache?.normalRoughness?.base
    : cache?.pipelines.get(mipmapPipelineKey(descriptor.format, descriptor.filter));
  if (normal && descriptor.format !== 'rgba8unorm')
    return err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'linear RGBA8 normal-roughness mips',
        hint: 'use rgba8unorm for normal-roughness output',
      }),
    );
  if (pipeline === undefined && (descriptor.filter === undefined || descriptor.filter === 'box')) {
    const prepared = prepareNativeBoxPipeline(device, state, descriptor.format);
    if (prepared !== undefined) {
      if (!prepared.ok) return prepared;
      pipeline = prepared.value;
      cache = state?.cache;
    }
  }
  if (cache === undefined || pipeline === undefined)
    return missingMipmapPipeline(descriptor.format);
  return encodePreparedMipmaps(
    device,
    encoder,
    texture,
    descriptor,
    levels,
    pipeline,
    cache,
    capture,
  );
}

/** Encoder work owns any transient textures until its submit or abort. */
function encodePreparedMipmaps(
  device: RhiDevice,
  encoder: RhiCommandEncoder,
  texture: Texture,
  descriptor: MipmapTextureDescriptor,
  levels: number,
  pipeline: RenderPipeline,
  cache: MipmapPipelineCache,
  capture: ((release: () => void) => void) | undefined,
): Result<() => void, RhiError> {
  const transient: Texture[] = [];
  let encoding = true,
    cancelled = false,
    released = false;
  let failure: { readonly cause: unknown } | undefined;
  const release = () => {
    if (failure !== undefined) throw failure.cause;
    if (encoding) {
      cancelled = true;
      return;
    }
    if (released) return;
    released = true;
    const failures: unknown[] = [];
    for (const texture of transient) {
      try {
        const result = device.destroyTexture(texture);
        if (!result.ok) failures.push(result.error);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) {
      failure = {
        cause:
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, 'mipmap scratch retirement failed'),
      };
      throw failure.cause;
    }
    transient.length = 0;
  };
  let encoded: Result<void, RhiError> | undefined;
  let thrown: { readonly cause: unknown } | undefined;
  try {
    capture?.(release);
    if (!cancelled)
      encoded =
        descriptor.filter === 'normal-roughness' && cache.normalRoughness !== undefined
          ? encodeNormalRoughnessMipmaps(
              device,
              encoder,
              texture,
              descriptor,
              levels,
              cache,
              cache.normalRoughness,
              transient,
            )
          : encodeMipmapBlit(
              device,
              encoder,
              texture,
              descriptor,
              levels,
              pipeline,
              cache,
              transient,
            );
  } catch (cause) {
    thrown = { cause };
  }
  encoding = false;
  const cleanup = (primary: unknown) => {
    try {
      release();
    } catch (cause) {
      // This realm-local receipt retains the exact unconfirmed scratch identities.
      throw new AggregateError([primary, cause], 'mipmap preparation and retirement failed', {
        cause: release,
      });
    }
  };
  if (thrown !== undefined) {
    cleanup(thrown.cause);
    throw thrown.cause;
  }
  if (encoded === undefined || !encoded.ok || cancelled) {
    const error = encoded !== undefined && !encoded.ok ? encoded.error : unavailableMipmapWork();
    cleanup(error);
    return err(error);
  }
  return ok(release);
}
function unavailableMipmapWork(): RhiError {
  return new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'an encoded, open mipmap transaction',
    hint: 'discard the cancelled or incomplete transaction without submitting it',
  });
}

/**
 * Prepare a mip chain without creating a hidden submission.
 * `finish()` is the explicit transaction boundary and is intentionally
 * separate from `queue.submit()` so recovery can guard candidate ownership.
 */
export function prepareMipmaps(
  device: RhiDevice,
  texture: Texture,
  descriptor: MipmapTextureDescriptor,
  capture?: (work: MipmapEncoderWork) => void,
): Result<MipmapEncoderWork, RhiError> {
  const levels = descriptor.levels ?? numMipLevels(descriptor);
  if (levels <= 1) {
    const work = { finish: () => ok(undefined), discard: () => undefined };
    capture?.(work);
    return ok(work);
  }
  const encoder = device.createCommandEncoder({ label: 'mipmap-recovery-setup-encoder' });
  if (!encoder.ok) return encoder;
  let encoding = true,
    cancelled = false,
    closed = false,
    released = false;
  let releaseScratch: (() => void) | undefined;
  let discardFailure: { readonly cause: unknown } | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      encoder.value.finish();
    } catch {
      /* No abort API; never submit this encoder. */
    }
  };
  const work: MipmapEncoderWork = {
    finish: () => {
      if (encoding || cancelled || closed) return err(unavailableMipmapWork());
      closed = true;
      return encoder.value.finish();
    },
    discard: () => {
      if (discardFailure !== undefined) throw discardFailure.cause;
      if (encoding) {
        cancelled = true;
        return;
      }
      if (released) return;
      released = true;
      close();
      try {
        releaseScratch?.();
      } catch (cause) {
        discardFailure = { cause };
        throw cause;
      }
    },
  };
  let result: Result<() => void, RhiError> | undefined;
  try {
    capture?.(work);
    if (!cancelled)
      result = encodeMipmaps(device, encoder.value, texture, descriptor, (release) => {
        releaseScratch = release;
      });
  } catch (cause) {
    encoding = false;
    close();
    throw cause;
  }
  encoding = false;
  if (result === undefined || !result.ok || cancelled) {
    work.discard();
    return result !== undefined && !result.ok ? result : err(unavailableMipmapWork());
  }
  return ok(work);
}

/**
 * Per-mip render-pass blit-loop (research F-1 SSOT main template).
 *
 * For mip levels 1..levels-1: source view = previous mip {baseMipLevel:i-1,
 * mipLevelCount:1}; destination view = current mip {baseMipLevel:i,
 * mipLevelCount:1, usage: RENDER_ATTACHMENT}; oversized-triangle pipeline
 * draws 3 vertices, fragment shader samples source via linear sampler.
 *
 * Spec sRGB correctness (F-3): when format is `*-srgb`, both views inherit
 * the sRGB encoding so hardware decode -> bilinear in linear -> encode back
 * happens automatically; no special-casing required.
 *
 * `levels` defaults to `numMipLevels({ width, height })`. AI users that
 * already created the texture with explicit `mipLevelCount` should pass the
 * same value here.
 */
export async function generateMipmaps(
  device: RhiDevice,
  texture: Texture,
  descriptor: MipmapTextureDescriptor,
  asyncCreateShaderModule: MipmapShaderModuleFactory,
): Promise<Result<void, RhiError>> {
  const levels = descriptor.levels ?? numMipLevels(descriptor);
  if (levels <= 1) return ok(undefined);

  const pipelineRes = await getOrCreateMipmapPipeline(
    device,
    descriptor.format,
    asyncCreateShaderModule,
    descriptor.filter,
  );
  if (!pipelineRes.ok) return pipelineRes;
  return blitMipmapsSync(device, texture, descriptor);
}

/** Encode and submit a mip chain synchronously. Native box filters can create
 * their pipeline on first use. Other configurations prepare the format first. */
export function blitMipmapsSync(
  device: RhiDevice,
  texture: Texture,
  descriptor: MipmapTextureDescriptor,
): Result<void, RhiError> {
  const levels = descriptor.levels ?? numMipLevels(descriptor);
  if (levels <= 1) return ok(undefined);

  const prepared = prepareMipmaps(device, texture, descriptor);
  if (!prepared.ok) return prepared;
  const finished = prepared.value.finish();
  const submitted =
    !finished.ok || finished.value === undefined ? finished : device.queue.submit([finished.value]);
  prepared.value.discard();
  return submitted.ok ? ok(undefined) : submitted;
}

function missingMipmapPipeline(format: GPUTextureFormat): Result<never, RhiError> {
  return err(
    new RhiError({
      code: 'rhi-not-available',
      expected: `mipmap pipeline for format ${format} available`,
      hint: 'prepare the texture format before encoding or configure the native mipmap compiler',
    }),
  );
}

/** Encode one box-filter mip level into a caller-owned graph render pass. */
export function encodeMipmapLevel(
  device: RhiDevice,
  pass: RhiRenderPassEncoder,
  sourceView: TextureView,
  format: GPUTextureFormat,
): Result<void, RhiError> {
  const state = mipmapDevices.get(device);
  let cache = state?.cache;
  let pipeline = cache?.pipelines.get(mipmapPipelineKey(format));
  if (pipeline === undefined) {
    const prepared = prepareNativeBoxPipeline(device, state, format);
    if (prepared === undefined) return missingMipmapPipeline(format);
    if (!prepared.ok) return prepared;
    pipeline = prepared.value;
    cache = state?.cache;
  }
  if (cache === undefined) return missingMipmapPipeline(format);
  const bindGroup = device.createBindGroup({
    label: 'mipmap-graph-bind-group',
    layout: cache.layout,
    entries: [
      { binding: 0, resource: { kind: 'sampler', value: cache.sampler } },
      { binding: 1, resource: { kind: 'textureView', value: sourceView } },
    ],
  });
  if (!bindGroup.ok) return bindGroup;
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup.value);
  pass.draw(3, 1, 0, 0);
  return ok(undefined);
}
