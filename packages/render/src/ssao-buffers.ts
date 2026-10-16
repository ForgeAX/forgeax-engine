// @forgeax/engine-runtime — SSAO per-runtime persistent GPU buffers.
//
// feat-20260612-hdrp-ssao M1 / w4.
//
// Owner of 3 SSAO GPU resources, lazily allocated per RenderSystemRuntime,
// following the getOrCreateHdrpBuffers WeakMap pattern (research F12):
//   (1) kernel UBO  — 64 padded vec4 samples (1024 B), label hdrp-ssao-kernel
//   (2) noise texture — 4x4 rgba32float, label hdrp-ssao-noise, NEAREST/REPEAT
//   (3) uniform UBO   — 3 mat4 + vec4 intensityPad (256 B aligned),
//                       label hdrp-ssao-uniform
//
// plan-strategy D-1: uniform carries view + projection + inverseProjection.
// plan-strategy D-C: intensity, radius, and bias are carried at offset 192
//   (the existing vec4 slot), so the lighting shader can mix(1.0, ssao*ao,
//   intensity) without a new UBO.
// The kernel uses a uniform buffer on every backend. 1024 B is below the
// WebGL2 minimum fragment UBO size, so SSAO does not need a storage-buffer
// capability gate.

import type { Buffer, Sampler, Texture, TextureView } from '@forgeax/engine-rhi';
import { GPU_TEXTURE_USAGE_COPY_DST, GPU_TEXTURE_USAGE_TEXTURE_BINDING } from './gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from './gpu-usage';
import { texelFallbackDescriptor, writeTexelFallback } from './ibl/skylight-bind-group';
import type { RenderSystemRuntime } from './record/render-context';

// Deterministic host-side SSAO data is owned by the buffer allocator because
// these values have no consumer outside the resources they initialize.
export const SSAO_KERNEL_SAMPLE_COUNT = 64;
const NOISE_SIZE = 16;

function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

export function generateSsaoKernel(seed: number = 0): readonly Float32Array[] {
  const rand = mulberry32(seed);
  const kernel: Float32Array[] = [];
  for (let i = 0; i < SSAO_KERNEL_SAMPLE_COUNT; i++) {
    let x = rand() * 2 - 1;
    let y = rand() * 2 - 1;
    let z = rand();
    const len = Math.sqrt(x * x + y * y + z * z);
    x /= len;
    y /= len;
    z /= len;
    const r = rand();
    x *= r;
    y *= r;
    z *= r;
    const scale = lerp(0.1, 1.0, (i / SSAO_KERNEL_SAMPLE_COUNT) ** 2);
    const sample = new Float32Array(3);
    sample[0] = x * scale;
    sample[1] = y * scale;
    sample[2] = z * scale;
    kernel.push(sample);
  }
  return kernel;
}

export function generateSsaoNoise(seed: number = 0): Float32Array {
  const rand = mulberry32(seed);
  const noise = new Float32Array(NOISE_SIZE * 3);
  for (let i = 0; i < NOISE_SIZE; i++) {
    noise[i * 3 + 0] = rand() * 2 - 1;
    noise[i * 3 + 1] = rand() * 2 - 1;
    noise[i * 3 + 2] = 0;
  }
  return noise;
}

// Each vec3<f32> in a WGSL array is 16B (12B payload + 4B padding).
// 64 samples * 16 B/sample = 1024 B.
const BYTES_PER_KERNEL_ELEMENT = 16;

// SSAO uniform layout (plan-strategy §D-1 + §D-C, M7 round-2):
//   bytes [0..63]    view              mat4x4<f32>
//   bytes [64..127]  projection        mat4x4<f32>
//   bytes [128..191] inverseProjection mat4x4<f32>
//   bytes [192..207] intensityPad      vec4<f32>  // x = intensity, y = radius, z = bias, w = sample budget
//   bytes [208..223] algorithmPad      vec4<f32>  // x = 0 SSAO, 1 GTAO
//   bytes [224..255] padding           // align to 256B WebGPU UBO offset
//
// The total is rounded to 256B so the same UBO can host an additional
// shader-side scalar binding at the tail without re-allocation.
const UNIFORM_INTENSITY_OFFSET_BYTES = 192;
const UNIFORM_BYTES = 256;
export const SSAO_UNIFORM_INTENSITY_OFFSET = UNIFORM_INTENSITY_OFFSET_BYTES;
export const SSAO_UNIFORM_BYTES = UNIFORM_BYTES;

// ── 1x1 white fallback texture (plan-strategy §D-B) ───────────────────────
//
// Single-PSO invariant: the HDRP unified BGL always declares a binding 7
// texture_2d<f32>. When SSAO is disabled (or its resources are not yet
// allocated), the bind group binds this 1x1 r8unorm texture filled with
// 0xFF. r8unorm normalizes 255 -> 1.0, so the lighting shader reads
// `ssaoFactor = 1.0`, and `mix(1.0, ssao*ao, intensity) = ao` collapses
// back to the round-1 baseline (ambient = baked-AO only). No shader
// recompile across enable/disable.

interface SsaoFallbackResources {
  readonly device: RenderSystemRuntime['device'];
  readonly texture: Texture;
  readonly view: TextureView;
  readonly sampler: Sampler;
}

const fallbackCache = new WeakMap<RenderSystemRuntime, SsaoFallbackResources>();

function destroyBuffer(
  runtime: RenderSystemRuntime,
  device: RenderSystemRuntime['device'],
  buffer: Buffer,
): void {
  const destroyed = device.destroyBuffer(buffer);
  if (!destroyed.ok) runtime.errorRegistry.fire(destroyed.error);
}

function destroyTexture(
  runtime: RenderSystemRuntime,
  device: RenderSystemRuntime['device'],
  texture: Texture,
): void {
  const destroyed = device.destroyTexture(texture);
  if (!destroyed.ok) runtime.errorRegistry.fire(destroyed.error);
}

function retireSsaoResources(device: RenderSystemRuntime['device'], release: () => void): void {
  const queue = device.queue as {
    readonly onSubmittedWorkDone?: () => Promise<undefined>;
  };
  if (typeof queue.onSubmittedWorkDone === 'function') {
    try {
      void queue.onSubmittedWorkDone().then(release, release);
      return;
    } catch {
      // A lost or minimal test device may reject the fence synchronously.
    }
  }
  // There is no submitted work to fence on minimal RHI fixtures.  Releasing
  // synchronously keeps cache reset deterministic for those callers.
  release();
}

function destroySsaoFallbackResources(
  runtime: RenderSystemRuntime,
  resources: SsaoFallbackResources,
): void {
  destroyTexture(runtime, resources.device, resources.texture);
}

/**
 * Lazily allocate the 1x1 r8unorm white fallback texture + a sampler for
 * SSAO disabled / resource-missing path. Cached per RenderSystemRuntime so
 * subsequent calls reuse the same resources (charter P5 one-owner).
 *
 * Returns `null` if `device.createTexture` / `createTextureView` /
 * `createSampler` / `queue.writeTexture` fails; the caller (createBindGroup)
 * propagates the structured RhiError that landed on `runtime.errorRegistry`.
 */
export function getOrCreateSsaoFallbackTexture(
  runtime: RenderSystemRuntime,
): SsaoFallbackResources | null {
  const cached = fallbackCache.get(runtime);
  if (cached !== undefined && cached.device === runtime.device) return cached;
  if (cached !== undefined) {
    fallbackCache.delete(runtime);
    retireSsaoResources(cached.device, () => destroySsaoFallbackResources(runtime, cached));
  }

  const device = runtime.device;
  const descriptor = texelFallbackDescriptor('hdrp-ssao-fallback-white', 'r8unorm');
  const texRes = device.createTexture(descriptor);
  if (!texRes.ok) {
    runtime.errorRegistry.fire(texRes.error);
    return null;
  }

  // r8unorm: a single byte 0xFF normalizes to 1.0 (white => AO = 1.0).
  const writeRes = writeTexelFallback(
    device.queue,
    texRes.value,
    descriptor,
    new Uint8Array([255]),
  );
  if (!writeRes.ok) {
    runtime.errorRegistry.fire(writeRes.error);
    destroyTexture(runtime, device, texRes.value);
    return null;
  }

  const viewRes = device.createTextureView(texRes.value, {
    label: 'hdrp-ssao-fallback-white-view',
    format: 'r8unorm',
    dimension: '2d',
    aspect: 'all',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!viewRes.ok) {
    runtime.errorRegistry.fire(viewRes.error);
    destroyTexture(runtime, device, texRes.value);
    return null;
  }

  const samplerRes = device.createSampler({
    label: 'hdrp-ssao-fallback-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  });
  if (!samplerRes.ok) {
    runtime.errorRegistry.fire(samplerRes.error);
    destroyTexture(runtime, device, texRes.value);
    return null;
  }

  const resources: SsaoFallbackResources = {
    device,
    texture: texRes.value,
    view: viewRes.value,
    sampler: samplerRes.value,
  };
  fallbackCache.set(runtime, resources);
  return resources;
}

/**
 * SSAO GPU resources owned by this module (plan-strategy D-1, D-4).
 *
 * Fields are readonly per charter P5: one resource, one owner.
 */
export interface SsaoBuffers {
  /** Device identity that owns every handle in this bundle. */
  readonly device: RenderSystemRuntime['device'];
  /** 64 padded vec4 uniform buffer for hemisphere samples. */
  readonly kernelBuffer: Buffer;
  readonly kernelBytes: number;
  /** 4x4 rgba32float noise texture for per-pixel TBN rotation. */
  readonly noiseTexture: Texture;
  /** SSAO uniform UBO: view (mat4) + projection (mat4) + inverseProjection (mat4). */
  readonly uniformBuffer: Buffer;
  readonly uniformBytes: number;
}

const cache = new WeakMap<RenderSystemRuntime, SsaoBuffers>();

function destroySsaoBufferResources(runtime: RenderSystemRuntime, buffers: SsaoBuffers): void {
  for (const buffer of [buffers.kernelBuffer, buffers.uniformBuffer]) {
    destroyBuffer(runtime, buffers.device, buffer);
  }
  destroyTexture(runtime, buffers.device, buffers.noiseTexture);
}

function destroyCreatedSsaoResources(
  runtime: RenderSystemRuntime,
  device: RenderSystemRuntime['device'],
  buffers: readonly Buffer[],
  textures: readonly Texture[],
): void {
  for (const buffer of buffers) destroyBuffer(runtime, device, buffer);
  for (const texture of textures) destroyTexture(runtime, device, texture);
}

/**
 * Release every persistent SSAO resource owned by one renderer runtime.
 *
 * The fallback texture and the enabled-path buffers are module caches keyed by
 * the runtime object, so Renderer.dispose()/recover() must explicitly retire
 * them.  Cache eviction alone loses the only owner and leaves the backing RHI
 * handles live until the device itself is collected.
 */
export function resetSsaoResources(runtime: RenderSystemRuntime): void {
  const buffers = cache.get(runtime);
  if (buffers !== undefined) {
    cache.delete(runtime);
    retireSsaoResources(buffers.device, () => destroySsaoBufferResources(runtime, buffers));
  }
  const fallback = fallbackCache.get(runtime);
  if (fallback !== undefined) {
    fallbackCache.delete(runtime);
    retireSsaoResources(fallback.device, () => destroySsaoFallbackResources(runtime, fallback));
  }
}

/**
 * Lazily allocate the 3 SSAO GPU resources for `runtime`. Returns the
 * same `SsaoBuffers` object on subsequent calls (per-RenderSystem
 * stable identity, WeakMap).
 *
 * On `device.createBuffer` / `device.createTexture` failure, fires a
 * structured error on the runtime's error registry and returns `null`.
 *
 * @returns SsaoBuffers on success, null if an allocation fails.
 */
export function getOrCreateSsaoBuffers(runtime: RenderSystemRuntime): SsaoBuffers | null {
  const cached = cache.get(runtime);
  if (cached !== undefined && cached.device === runtime.device) return cached;
  if (cached !== undefined) {
    cache.delete(runtime);
    retireSsaoResources(cached.device, () => destroySsaoBufferResources(runtime, cached));
  }

  const device = runtime.device;

  // (1) Kernel UBO — 64 padded vec4 samples (1024 B).
  const kernelSamples = generateSsaoKernel();
  const kernelData = new Float32Array(SSAO_KERNEL_SAMPLE_COUNT * 4); // 4 floats per padded vec3
  for (let i = 0; i < SSAO_KERNEL_SAMPLE_COUNT; i++) {
    const s = kernelSamples[i];
    if (s === undefined) continue;
    kernelData[i * 4 + 0] = s[0] ?? 0;
    kernelData[i * 4 + 1] = s[1] ?? 0;
    kernelData[i * 4 + 2] = s[2] ?? 0;
    // kernelData[i * 4 + 3] = 0 (padding for std140 vec3 alignment)
  }

  const kernelBufferRes = device.createBuffer({
    label: 'hdrp-ssao-kernel',
    size: SSAO_KERNEL_SAMPLE_COUNT * BYTES_PER_KERNEL_ELEMENT,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!kernelBufferRes.ok) {
    runtime.errorRegistry.fire(kernelBufferRes.error);
    return null;
  }

  // Upload kernel data to the buffer.
  const kernelWriteRes = device.queue.writeBuffer(kernelBufferRes.value, 0, kernelData);
  if (!kernelWriteRes.ok) {
    runtime.errorRegistry.fire(kernelWriteRes.error);
    destroyBuffer(runtime, device, kernelBufferRes.value);
    return null;
  }

  // (2) Noise texture — 4x4 rgba32float, NEAREST/REPEAT.
  const noiseData = generateSsaoNoise();
  // Pad to rgba32float: 16 texels * 4 floats = 64 floats.
  const noiseRgba = new Float32Array(16 * 4);
  for (let i = 0; i < 16; i++) {
    noiseRgba[i * 4 + 0] = noiseData[i * 3 + 0] ?? 0;
    noiseRgba[i * 4 + 1] = noiseData[i * 3 + 1] ?? 0;
    noiseRgba[i * 4 + 2] = 0;
    noiseRgba[i * 4 + 3] = 1; // alpha = 1 for rgba32float
  }

  const noiseTexRes = device.createTexture({
    label: 'hdrp-ssao-noise',
    size: { width: 4, height: 4, depthOrArrayLayers: 1 },
    mipLevelCount: 1,
    sampleCount: 1,
    dimension: '2d',
    format: 'rgba32float',
    usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    textureBindingViewDimension: undefined,
  });
  if (!noiseTexRes.ok) {
    runtime.errorRegistry.fire(noiseTexRes.error);
    destroyBuffer(runtime, device, kernelBufferRes.value);
    return null;
  }

  // Direct CPU-to-GPU upload via writeTexture (no alignment requirement
  // unlike copyBufferToTexture; WebGPU spec §19.2). 4x4 rgba32float texture
  // = 16 texels * 4 floats * 4 bytes/float = 256 bytes.
  // The forgeax Texture brand wraps a raw GPUTexture; cast through unknown
  // follows the createRenderer.ts fallback-pixel pattern (line 4330).
  const noiseCopyRes = device.queue.writeTexture(
    {
      texture: noiseTexRes.value,
      mipLevel: 0,
      origin: { x: 0, y: 0, z: 0 },
    },
    noiseRgba,
    { offset: 0, bytesPerRow: 4 * 4 * 4, rowsPerImage: 4 },
    { width: 4, height: 4, depthOrArrayLayers: 1 },
  );
  if (!noiseCopyRes.ok) {
    runtime.errorRegistry.fire(noiseCopyRes.error);
    destroyCreatedSsaoResources(runtime, device, [kernelBufferRes.value], [noiseTexRes.value]);
    return null;
  }

  // (3) SSAO uniform UBO — 3 mat4 (192 B).
  const uniformBufRes = device.createBuffer({
    label: 'hdrp-ssao-uniform',
    size: UNIFORM_BYTES,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!uniformBufRes.ok) {
    runtime.errorRegistry.fire(uniformBufRes.error);
    destroyCreatedSsaoResources(runtime, device, [kernelBufferRes.value], [noiseTexRes.value]);
    return null;
  }

  const buffers: SsaoBuffers = {
    device,
    kernelBuffer: kernelBufferRes.value,
    kernelBytes: SSAO_KERNEL_SAMPLE_COUNT * BYTES_PER_KERNEL_ELEMENT,
    noiseTexture: noiseTexRes.value,
    uniformBuffer: uniformBufRes.value,
    uniformBytes: UNIFORM_BYTES,
  };

  cache.set(runtime, buffers);
  return buffers;
}
