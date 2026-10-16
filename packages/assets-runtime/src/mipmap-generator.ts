// @forgeax/engine-assets-runtime - mipmap-generator.ts (T-M3-04).
//
// Independent-file home of the runtime mipmap auto-generation utility
// (plan-strategy section 2.6 D Open Q-5 selection (a)). Purposefully lives
// outside `asset-registry.ts` so the asset-registry stays single-purpose
// (charter proposition 5 producer / consumer split; architecture-principles
// pipeline isolation).
//
// Shader-module DI boundary (bug-20260518 D-1): the per-device pipeline
// cache builds its single ShaderModule via an injected
// `MipmapShaderModuleFactory`, NOT via `device.createShaderModule` -- the
// post-fix-f3 `RhiDevice` surface has no synchronous `createShaderModule`
// member, and the runtime mipmap utility must NOT reverse-import the
// rhi-webgpu shim package (charter F1 layering). The factory is wired
// once at `createRenderer.ts` from `pack.createShaderModule` and threaded
// through `AssetRegistry.configureGpuDevice` -> `generateMipmaps` ->
// `getOrCreateMipmapPipeline` -> `ensureDeviceCache`.
//
// SSOT three-source convergence (research F-1 + F-2):
//   - webgpufundamentals importing-textures-mipmaps  (formula + main loop)
//   - toji web-texture-tool webgpu-mipmap-generator  (oversized triangle WGSL)
//   - greggman webgpu-utils generate-mipmap          (WeakMap<GPUDevice> cache)
//
// Public surface (charter F2 minimal):
//   - numMipLevels({ width, height })                    -> number      (formula SSOT)
//   - getOrCreateMipmapPipeline(device, format)          -> Result      (cache lookup; per-format)
//   - mipmapCacheSize(device)                            -> number      (introspection)
//   - generateMipmaps(device, texture, descriptor)       -> Result<void>(per-mip render-pass blit-loop)
//
// Per-device cache structure (greggman SSOT):
//   WeakMap<MipmapDevice, MipmapPipelineCache>
//     where MipmapPipelineCache = {
//       sampler:  Sampler,                    // shared linear / linear / linear sampler (F-5)
//       module:   ShaderModule,               // shared oversized-triangle vertex + sampling fragment WGSL
//       layout:   BindGroupLayout,            // shared sampler @binding(0) + texture_2d<f32> @binding(1)
//       pipelines: Map<GPUTextureFormat, RenderPipeline>  // per-format pipeline (F-2 cache key)
//     }
// Per-device isolation prevents pipeline leak across `createRenderer` calls
// (charter P5 consistent abstraction; greggman 36-44 anchor).
//
// Why this layout (not closure / not class):
//   - `getOrCreateMipmapPipeline` is module-level for test surface (T-M3-01
//     directly imports it; cache reference equality assertions need stable
//     identity across calls).
//   - `numMipLevels` is pure (no device argument); the WeakMap lookup only
//     happens at pipeline-create time.

import {
  type CommandBuffer,
  err,
  ok,
  type Result,
  type RhiCommandEncoder,
  RhiError,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';

/**
 * Subset of `RhiDevice` consumed by the mipmap utility (charter F2: only
 * the methods the algorithm actually invokes; the dawn integration tests
 * pass a real `RhiDevice` and the unit cache tests pass a hand-rolled stub).
 *
 * Four entry-points (all synchronous Result):
 *   - createSampler       (default linear / linear / linear)
 *   - createBindGroupLayout
 *   - createPipelineLayout
 *   - createRenderPipeline (per-format pipeline cache miss)
 *
 * Shader module is NOT an entry-point here; it is supplied by an injected
 * `MipmapShaderModuleFactory` (bug-20260518 D-1) so the utility does not
 * reach into the rhi-webgpu shim package from the runtime layer.
 *
 * Plus `createCommandEncoder` + `queue.submit` are added once the upload
 * call-site (T-M3-05) wires generateMipmaps in; the cache-only public hooks
 * exercised by T-M3-01 do not need them, so they live behind an extended
 * MipmapDeviceForBlit alias.
 */
export type MipmapDevice = {
  // biome-ignore lint/suspicious/noExplicitAny: shim accepts any descriptor
  createSampler(desc?: any): Result<any, any>;
  // biome-ignore lint/suspicious/noExplicitAny: shim accepts any descriptor
  createBindGroupLayout(desc: any): Result<any, any>;
  // biome-ignore lint/suspicious/noExplicitAny: shim accepts any descriptor
  createPipelineLayout(desc: any): Result<any, any>;
  // biome-ignore lint/suspicious/noExplicitAny: shim accepts any descriptor
  createRenderPipeline(desc: any): Result<any, any>;
};

/**
 * Async shader-module factory injected through the call-chain
 * `createRenderer.ts` -> `AssetRegistry.configureGpuDevice` ->
 * `generateMipmaps` -> `getOrCreateMipmapPipeline` -> `ensureDeviceCache`
 * (bug-20260518 D-1 / D-4).
 *
 * Signature mirrors the top-level async `createShaderModule(device, desc)`
 * exposed by the rhi-webgpu shim (and the rhi-wgpu shim) so the
 * call-site in createRenderer can pass `pack.createShaderModule` directly
 * without a structural cast. The opaque module value is typed `unknown`
 * here -- callers do not introspect it; they hand the value back to
 * `createRenderPipeline` descriptors via the cached `MipmapPipelineCache`.
 */
export type MipmapShaderModuleFactory = (
  device: MipmapDevice,
  desc: { code: string; label?: string },
) => Promise<Result<unknown, RhiError>>;

/**
 * Per-device pipeline cache structure (research F-2 SSOT).
 * Held under a module-private `WeakMap<MipmapDevice, MipmapPipelineCache>`.
 */
interface MipmapPipelineCache {
  // biome-ignore lint/suspicious/noExplicitAny: cached opaque GPU sampler
  readonly sampler: any;
  // biome-ignore lint/suspicious/noExplicitAny: cached opaque GPU shader module
  readonly module: any;
  // biome-ignore lint/suspicious/noExplicitAny: cached opaque GPU bind-group layout
  readonly layout: any;
  // biome-ignore lint/suspicious/noExplicitAny: per-format render pipeline cache
  readonly pipelines: Map<GPUTextureFormat, any>;
}

// Module-private cache (greggman 36-44 SSOT). WeakMap so that destroying a
// device naturally clears its cache (no manual cleanup hook needed).
const deviceCache: WeakMap<MipmapDevice, MipmapPipelineCache> = new WeakMap();

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
 * Compute mip-level count for a 2D texture (research F-1 SSOT formula).
 *
 * Spec-anchor: WebGPU §3.6 texture-creation says `mipLevelCount` defaults
 * to 1; the runtime utility opts AI users into a full chain via
 * `floor(log2(max(width, height))) + 1` -- the same formula greggman /
 * toji / webgpufundamentals all converge on.
 *
 * @example
 *   numMipLevels({ width: 256, height: 256 }) // 9
 *   numMipLevels({ width: 1, height: 1 })     // 1
 */
export function numMipLevels(size: { width: number; height: number }): number {
  const max = Math.max(size.width, size.height);
  if (max <= 1) return 1;
  return Math.floor(Math.log2(max)) + 1;
}

/**
 * Number of cached pipelines for the device (introspection hook used by
 * T-M3-01 (c) cache-hit / (d) per-device-isolation tests; charter P3
 * explicit failure: a cache size of 0 on a fresh device is a witnessed
 * pre-condition rather than a swept-under hint).
 */
export function mipmapCacheSize(device: MipmapDevice): number {
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
  device: MipmapDevice,
  format: GPUTextureFormat,
  asyncCreateShaderModule: MipmapShaderModuleFactory,
  // biome-ignore lint/suspicious/noExplicitAny: returns opaque GPU pipeline
): Promise<Result<any, unknown>> {
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
    vertex: { module: cache.value.module, entryPoint: 'vs_main' },
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

async function ensureDeviceCache(
  device: MipmapDevice,
  asyncCreateShaderModule: MipmapShaderModuleFactory,
): Promise<Result<MipmapPipelineCache, RhiError>> {
  const existing = deviceCache.get(device);
  if (existing !== undefined) return ok(existing);

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

/**
 * Extended device shape used by `generateMipmaps` (call-site T-M3-05).
 * Adds command-encoder + bind-group + texture-view + queue surfaces beyond
 * the cache-only `MipmapDevice` so the pipeline-cache unit tests still
 * compile against the smaller surface.
 */
export type MipmapBlitDevice = MipmapDevice & {
  // biome-ignore lint/suspicious/noExplicitAny: shim accepts any descriptor
  createTexture(desc: any): Result<any, any>;
  // biome-ignore lint/suspicious/noExplicitAny: shim accepts any descriptor
  createBindGroup(desc: any): Result<any, any>;
  // biome-ignore lint/suspicious/noExplicitAny: shim accepts any descriptor
  createTextureView(texture: any, desc: any): Result<any, any>;
  // biome-ignore lint/suspicious/noExplicitAny: shim accepts any descriptor
  createCommandEncoder(desc?: any): Result<any, any>;
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture handle
  destroyTexture(texture: any): Result<void, any>;
  readonly queue: {
    // biome-ignore lint/suspicious/noExplicitAny: shim accepts any descriptor
    submit(buffers: ReadonlyArray<any>): Result<void, any>;
  };
};

// COPY_SRC | RENDER_ATTACHMENT.
const MIPMAP_SCRATCH_USAGE = 0x01 | 0x10;

interface MipmapTextureDescriptor {
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
  device: MipmapBlitDevice,
  encoder: RhiCommandEncoder,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture handle
  texture: any,
  descriptor: MipmapTextureDescriptor,
  levels: number,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU pipeline handle
  pipeline: any,
  cache: MipmapPipelineCache,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture handle
): Result<any, RhiError> {
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
    size: [Math.max(1, descriptor.width >> 1), Math.max(1, descriptor.height >> 1)],
    mipLevelCount: levels - 1,
    format: descriptor.format,
    usage: MIPMAP_SCRATCH_USAGE,
  });
  if (!scratchRes.ok) return scratchRes as Result<never, RhiError>;
  const scratch = scratchRes.value;
  const fail = (failure: Result<unknown, unknown>): Result<never, RhiError> => {
    device.destroyTexture(scratch);
    return failure as Result<never, RhiError>;
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
      if (!srcViewRes.ok) return fail(srcViewRes);

      const dstViewRes = device.createTextureView(scratch, {
        baseMipLevel: i - 1,
        mipLevelCount: 1,
        dimension: '2d',
      });
      if (!dstViewRes.ok) return fail(dstViewRes);

      const bindGroupRes = device.createBindGroup({
        label: `mipmap-bg-${i}`,
        layout: cache.layout,
        entries: [
          { binding: 0, resource: { kind: 'sampler', value: cache.sampler } },
          { binding: 1, resource: { kind: 'textureView', value: srcViewRes.value } },
        ],
      });
      if (!bindGroupRes.ok) return fail(bindGroupRes);

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
        [Math.max(1, descriptor.width >> i), Math.max(1, descriptor.height >> i), 1],
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

/**
 * Prepare a prewarmed mip chain without creating a hidden submission.
 * `finish()` is the explicit transaction boundary and is intentionally
 * separate from `queue.submit()` so recovery can guard candidate ownership.
 */
export function prepareMipmaps(
  device: MipmapBlitDevice,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture handle
  texture: any,
  descriptor: MipmapTextureDescriptor,
): Result<MipmapEncoderWork, RhiError> {
  const levels = descriptor.levels ?? numMipLevels(descriptor);
  if (levels <= 1) return ok({ finish: () => ok(undefined), discard: () => undefined });

  const cache = deviceCache.get(device);
  if (cache === undefined) {
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'mipmap pipeline cache prewarmed for this device before prepareMipmaps',
        hint: 'call prewarmMipmapPipeline(device, formats) before preparing recovery mip work',
      }),
    );
  }
  const pipeline = cache.pipelines.get(descriptor.format);
  if (pipeline === undefined) {
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: `mipmap pipeline for format ${descriptor.format} prewarmed`,
        hint: `format ${descriptor.format} was not prewarmed; add it to the prewarmMipmapPipeline format list`,
      }),
    );
  }
  const encoderRes = device.createCommandEncoder({ label: 'mipmap-recovery-setup-encoder' });
  if (!encoderRes.ok) return encoderRes as Result<MipmapEncoderWork, RhiError>;
  const encoded = encodeMipmapBlit(
    device,
    encoderRes.value,
    texture,
    descriptor,
    levels,
    pipeline,
    cache,
  );
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
      device.destroyTexture(encoded.value);
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
  device: MipmapBlitDevice,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture handle
  texture: any,
  descriptor: MipmapTextureDescriptor,
  asyncCreateShaderModule: MipmapShaderModuleFactory,
): Promise<Result<void, unknown>> {
  const levels = descriptor.levels ?? numMipLevels(descriptor);
  if (levels <= 1) return ok(undefined);

  const pipelineRes = await getOrCreateMipmapPipeline(
    device,
    descriptor.format,
    asyncCreateShaderModule,
  );
  if (!pipelineRes.ok) return pipelineRes;
  const prepared = prepareMipmaps(device, texture, descriptor);
  if (!prepared.ok) return prepared;
  const finished = prepared.value.finish();
  const submitted =
    !finished.ok || finished.value === undefined ? finished : device.queue.submit([finished.value]);
  prepared.value.discard();
  return submitted.ok ? ok(undefined) : submitted;
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
  device: MipmapBlitDevice,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture handle
  texture: any,
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
  device: MipmapBlitDevice,
  pass: RhiRenderPassEncoder,
  sourceView: unknown,
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
