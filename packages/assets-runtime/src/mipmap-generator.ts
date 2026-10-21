// Per-device, per-format mip pipelines. Shader compilation is injected from the
// selected backend; recording and submission use the shared RHI contract.

import {
  type BindGroupLayout,
  type CommandBuffer,
  err,
  ok,
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
import { mipDimension, numMipLevels } from '@forgeax/engine-types';

/** Inject the backend's async shader compiler without importing its implementation. */
export type MipmapShaderModuleFactory = (
  device: RhiDevice,
  desc: { code: string; label?: string },
) => Promise<Result<ShaderModule, RhiError>>;

/**
 * Per-device pipeline cache structure (research F-2 SSOT).
 * Held under a module-private `WeakMap<RhiDevice, MipmapPipelineCache>`.
 */
interface MipmapPipelineCache {
  readonly sampler: Sampler;
  readonly module: ShaderModule;
  readonly layout: BindGroupLayout;
  readonly pipelines: Map<GPUTextureFormat, RenderPipeline>;
}

// Module-private cache (greggman 36-44 SSOT). WeakMap so that destroying a
// device naturally clears its cache (no manual cleanup hook needed).
const deviceCache: WeakMap<RhiDevice, MipmapPipelineCache> = new WeakMap();

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
`;

/**
 * Number of cached pipelines for the device (introspection hook used by
 * T-M3-01 (c) cache-hit / (d) per-device-isolation tests; charter P3
 * explicit failure: a cache size of 0 on a fresh device is a witnessed
 * pre-condition rather than a swept-under hint).
 */
export function mipmapCacheSize(device: RhiDevice): number {
  const cache = deviceCache.get(device);
  return cache?.pipelines.size ?? 0;
}

/**
 * Get the existing per-format render pipeline or build a fresh one.
 *
 * Per-device WeakMap + per-format `Map<GPUTextureFormat, RenderPipeline>`
 * (greggman 36-44 + 119-122). The shared sampler / shader-module /
 * bind-group-layout are constructed lazily on the first cache miss for a
 * given device and reused across all formats on that device.
 */
export async function getOrCreateMipmapPipeline(
  device: RhiDevice,
  format: GPUTextureFormat,
  asyncCreateShaderModule: MipmapShaderModuleFactory,
): Promise<Result<RenderPipeline, RhiError>> {
  const cache = await ensureDeviceCache(device, asyncCreateShaderModule);
  if (!cache.ok) return cache;
  const existing = cache.value.pipelines.get(format);
  if (existing !== undefined) {
    return ok(existing);
  }
  const layoutRes = device.createPipelineLayout({
    label: 'mipmap-pl',
    bindGroupLayouts: [cache.value.layout],
  });
  if (!layoutRes.ok) return layoutRes;
  const pipelineRes = device.createRenderPipeline({
    label: `mipmap-pipeline-${format}`,
    layout: layoutRes.value,
    vertex: { module: cache.value.module, entryPoint: 'vs_main', buffers: [] },
    fragment: {
      module: cache.value.module,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list' },
  });
  if (!pipelineRes.ok) return pipelineRes;
  cache.value.pipelines.set(format, pipelineRes.value);
  return pipelineRes;
}

const devicePreparations = new WeakMap<RhiDevice, Promise<Result<MipmapPipelineCache, RhiError>>>();

async function ensureDeviceCache(
  device: RhiDevice,
  asyncCreateShaderModule: MipmapShaderModuleFactory,
): Promise<Result<MipmapPipelineCache, RhiError>> {
  const existing = deviceCache.get(device);
  if (existing !== undefined) return ok(existing);
  const preparing = devicePreparations.get(device);
  if (preparing !== undefined) return preparing;
  const pending = buildDeviceCache(device, asyncCreateShaderModule).finally(() =>
    devicePreparations.delete(device),
  );
  devicePreparations.set(device, pending);
  return pending;
}

async function buildDeviceCache(
  device: RhiDevice,
  asyncCreateShaderModule: MipmapShaderModuleFactory,
): Promise<Result<MipmapPipelineCache, RhiError>> {
  const moduleRes = await asyncCreateShaderModule(device, {
    code: MIPMAP_WGSL,
    label: 'mipmap-wgsl',
  });
  if (!moduleRes.ok) return moduleRes;

  const samplerRes = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
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

  const cache: MipmapPipelineCache = {
    sampler: samplerRes.value,
    module: moduleRes.value,
    layout: layoutRes.value,
    pipelines: new Map(),
  };
  deviceCache.set(device, cache);
  return ok(cache);
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
}

// Each layer renders from mip i-1 into a shared transient scratch level, then
// copies into that layer's mip i. No draw samples its own render attachment:
// some WebGL2 implementations reject even disjoint mips as a feedback loop.
// One scratch chain serves every layer and retains the target's sRGB format.
function encodeMipmapBlit(
  device: RhiDevice,
  encoder: RhiCommandEncoder,
  texture: Texture,
  descriptor: MipmapTextureDescriptor,
  levels: number,
  pipeline: RenderPipeline,
  cache: MipmapPipelineCache,
): Result<Texture, RhiError> {
  const arrayLayerCount = descriptor.arrayLayerCount ?? 1;
  if (!Number.isSafeInteger(arrayLayerCount) || arrayLayerCount < 1)
    return err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'mipmap arrayLayerCount is a positive integer',
        hint: 'provide the number of layers in the target 2D or cube texture',
      }),
    );
  const scratchRes = device.createTexture({
    label: 'mipmap-scratch',
    size: [mipDimension(descriptor.width, 1), mipDimension(descriptor.height, 1)],
    mipLevelCount: levels - 1,
    format: descriptor.format,
    usage: MIPMAP_SCRATCH_USAGE,
  });
  if (!scratchRes.ok) return scratchRes;
  const scratch = scratchRes.value;
  const fail = (error: RhiError): Result<never, RhiError> => {
    device.destroyTexture(scratch);
    return err(error);
  };
  for (let layer = 0; layer < arrayLayerCount; layer++) {
    for (let i = 1; i < levels; i++) {
      const srcViewRes = device.createTextureView(texture, {
        baseMipLevel: i - 1,
        mipLevelCount: 1,
        baseArrayLayer: layer,
        arrayLayerCount: 1,
        dimension: '2d',
      });
      if (!srcViewRes.ok) return fail(srcViewRes.error);

      const dstViewRes = device.createTextureView(scratch, {
        baseMipLevel: i - 1,
        mipLevelCount: 1,
        dimension: '2d',
      });
      if (!dstViewRes.ok) return fail(dstViewRes.error);

      const bindGroupRes = device.createBindGroup({
        label: `mipmap-bg-${i}`,
        layout: cache.layout,
        entries: [
          { binding: 0, resource: { kind: 'sampler', value: cache.sampler } },
          { binding: 1, resource: { kind: 'textureView', value: srcViewRes.value } },
        ],
      });
      if (!bindGroupRes.ok) return fail(bindGroupRes.error);

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
      encoder.copyTextureToTexture(
        { texture: scratch, mipLevel: i - 1 },
        { texture, mipLevel: i, origin: { x: 0, y: 0, z: layer } },
        [mipDimension(descriptor.width, i), mipDimension(descriptor.height, i), 1],
      );
    }
  }

  return ok(scratch);
}

/**
 * A caller-owned mip transaction. Preparation records render passes into one
 * encoder but never finishes or submits it; the recovery owner decides when
 * the setup command buffer crosses its candidate generation boundary.
 */
export interface MipmapEncoderWork {
  readonly finish: () => Result<CommandBuffer | undefined, RhiError>;
  /**
   * Close unsubmitted encoder work and release its transient scratch texture.
   * Call once after the finished buffer is submitted or the transaction aborts.
   */
  readonly discard: () => void;
}

/** Record into the submission owner's encoder; release scratch after submission or abort. */
export function encodeMipmaps(
  device: RhiDevice,
  encoder: RhiCommandEncoder,
  texture: Texture,
  descriptor: MipmapTextureDescriptor,
): Result<() => void, RhiError> {
  const levels = descriptor.levels ?? numMipLevels(descriptor);
  if (levels <= 1) return ok(() => {});
  const cache = deviceCache.get(device);
  const pipeline = cache?.pipelines.get(descriptor.format);
  if (cache === undefined || pipeline === undefined)
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: `prewarmed mipmap pipeline for ${descriptor.format}`,
        hint: 'prewarm the texture format before recording its mip chain',
      }),
    );
  const encoded = encodeMipmapBlit(device, encoder, texture, descriptor, levels, pipeline, cache);
  if (!encoded.ok) return encoded;
  let released = false;
  return ok(() => {
    if (released) return;
    released = true;
    device.destroyTexture(encoded.value);
  });
}

/**
 * Prepare a prewarmed mip chain without creating a hidden submission.
 * `finish()` is the explicit transaction boundary and is intentionally
 * separate from `queue.submit()` so recovery can guard candidate ownership.
 */
export function prepareMipmaps(
  device: RhiDevice,
  texture: Texture,
  descriptor: MipmapTextureDescriptor,
): Result<MipmapEncoderWork, RhiError> {
  const levels = descriptor.levels ?? numMipLevels(descriptor);
  if (levels <= 1) return ok({ finish: () => ok(undefined), discard: () => undefined });

  const encoderRes = device.createCommandEncoder({ label: 'mipmap-recovery-setup-encoder' });
  if (!encoderRes.ok) return encoderRes;
  const encoded = encodeMipmaps(device, encoderRes.value, texture, descriptor);
  if (!encoded.ok) {
    try {
      encoderRes.value.finish();
    } catch {
      // The preparation error is authoritative; the encoder has no separate
      // abort operation, so best-effort close is the only cleanup boundary.
    }
    return encoded;
  }
  let closed = false;
  let released = false;
  return ok({
    finish: () => {
      if (closed) {
        return err(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'mipmap recovery setup work is finished at most once',
            hint: 'discard the candidate transaction after finish and do not reuse its encoder',
          }),
        );
      }
      closed = true;
      return encoderRes.value.finish();
    },
    discard: () => {
      if (released) return;
      released = true;
      if (!closed) {
        closed = true;
        try {
          encoderRes.value.finish();
        } catch {
          // Candidate cleanup is idempotent and does not submit the discarded
          // command buffer.
        }
      }
      // Destruction after submission is deferred until the queued copies finish.
      encoded.value();
    },
  });
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
  );
  if (!pipelineRes.ok) return pipelineRes;
  return blitMipmapsSync(device, texture, descriptor);
}

/**
 * Synchronous sibling of `generateMipmaps` (feat-20260601-gpu-resource-store
 * -extraction D-9). Identical per-mip blit loop, but reads the per-format
 * pipeline + shared sampler / layout from the prewarmed device cache instead
 * of building them. The pipeline MUST already be present (via a prior
 * `getOrCreateMipmapPipeline` / `prewarmMipmapPipeline` async call) -- an
 * un-prewarmed device or format returns a structured `RhiError` rather than
 * awaiting a build, so the synchronous `draw(world)` frame contract is never
 * broken. The async build itself does not affect the written bytes (same
 * shader, same encoder sequence), so prewarm + sync blit reproduces the
 * pre-extraction async `generateMipmaps` byte-for-byte (D-9 sub-contract 5).
 */
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

/** Encode one prewarmed mip level into a caller-owned graph render pass. */
export function encodeMipmapLevel(
  device: RhiDevice,
  pass: RhiRenderPassEncoder,
  sourceView: TextureView,
  format: GPUTextureFormat,
): Result<void, RhiError> {
  const cache = deviceCache.get(device);
  if (cache === undefined) {
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'mipmap pipeline cache prewarmed for the graph device before encoding',
        hint: 'call prewarmMipmapPipeline(device, formats) at renderer.ready',
      }),
    );
  }
  const pipeline = cache.pipelines.get(format);
  if (pipeline === undefined) {
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: `mipmap pipeline for format ${format} prewarmed`,
        hint: `format ${format} was not prewarmed; add it to the renderer prewarm list`,
      }),
    );
  }
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
