import type { Buffer, Result, RhiDevice, RhiError, Sampler, Texture } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import type { DeviceScope } from '../../device/device-scope';

export const EXTENDED_LIGHTING_TOPOLOGY = 'extendedLighting' as const;
export const IES_SLICE_CAPACITY = 32;
export const COOKIE_SLICE_CAPACITY = 32;

export const IES_SLICE_WIDTH = 256;
export const IES_SLICE_HEIGHT = 128;
export const COOKIE_SLICE_SIZE = 256;
/**
 * The light-texture array keeps a full box-filtered mip chain. Spot Cookies
 * and projectors read level 0; RectAreaLight source textures select a
 * prefiltered level from the LTC lobe footprint.
 */
export const COOKIE_MIP_LEVEL_COUNT = Math.log2(COOKIE_SLICE_SIZE) + 1;
/** Bytes of one RGBA8 slice including every mip level, level 0 first. */
export const COOKIE_SLICE_MIP_CHAIN_BYTES = cookieMipChainBytes();

function cookieMipChainBytes(): number {
  let bytes = 0;
  for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
    const size = COOKIE_SLICE_SIZE >> level;
    bytes += size * size * 4;
  }
  return bytes;
}

/** Write one slice's level-0-first RGBA8 mip chain into the light-texture array. */
export function writeCookieSliceMipChain(
  device: RhiDevice,
  texture: Texture,
  slice: number,
  data: Uint8Array,
): Result<void, RhiError> {
  let offset = 0;
  for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
    const size = COOKIE_SLICE_SIZE >> level;
    const bytes = size * size * 4;
    const result = device.queue.writeTexture(
      { texture, mipLevel: level, origin: { x: 0, y: 0, z: slice } },
      data.subarray(offset, offset + bytes),
      { offset: 0, bytesPerRow: size * 4, rowsPerImage: size },
      { width: size, height: size, depthOrArrayLayers: 1 },
    );
    if (!result.ok) return result;
    offset += bytes;
  }
  return ok(undefined);
}
export const COOKIE_MATRIX_BYTES = 32 * 16 * Float32Array.BYTES_PER_ELEMENT;
/**
 * Minimum per-stage sampled-texture limit for the shared PBR + extended-
 * lighting pipeline-layout topology. The current BGL closure reserves 22
 * sampled textures for the URP path and 24 for the HDRP/Probe path after the
 * material IBL and transmission injections; WebGPU validates this pipeline-
 * layout count even when a compiled shader variant does not read every
 * optional entry.
 */
export const EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES = 24;

/**
 * Keep shader-variant selection and resource admission on one capability fact.
 * An omitted limit is treated as unavailable: a caller must not claim the
 * extended topology without a numeric device limit proving it fits.
 */
export function extendedLightingSampledTextureCapacityAvailable(
  maxSampledTexturesPerShaderStage: number | undefined,
): boolean {
  return (
    maxSampledTexturesPerShaderStage !== undefined &&
    maxSampledTexturesPerShaderStage >= EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES
  );
}

export interface ExtendedLightingCapabilityResult {
  readonly admitted: boolean;
  readonly topology: typeof EXTENDED_LIGHTING_TOPOLOGY;
  readonly reason: string | undefined;
}

export interface ExtendedLightingResourceCandidate {
  readonly topology: typeof EXTENDED_LIGHTING_TOPOLOGY;
  readonly generation: number;
  readonly scope: DeviceScope;
  readonly iesSliceCount: number;
  readonly cookieSliceCount: number;
  readonly cookieMatrices: number;
  readonly sampler: Sampler;
  readonly iesTexture: Texture | undefined;
  readonly cookieTexture: Texture | undefined;
  readonly cookieMatrixBuffer: Buffer | undefined;
  readonly descriptorBytes: number;
  readonly uploadCount: number;
}

/** Derive admission from the RHI facts; no backend-kind policy is involved. */
export function deriveExtendedLightingCapability(
  device: Pick<RhiDevice, 'caps' | 'limits'>,
): ExtendedLightingCapabilityResult {
  const maxSampledTextures = device.limits.maxSampledTexturesPerShaderStage;
  if (!extendedLightingSampledTextureCapacityAvailable(maxSampledTextures)) {
    return {
      admitted: false,
      topology: EXTENDED_LIGHTING_TOPOLOGY,
      reason: `maxSampledTexturesPerShaderStage ${maxSampledTextures ?? 0} < ${EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES}`,
    };
  }
  const maxLayers = device.limits.maxTextureArrayLayers ?? 0;
  const maxUniformBuffers = device.limits.maxUniformBuffersPerShaderStage ?? 0;
  if (maxLayers < IES_SLICE_CAPACITY) {
    return {
      admitted: false,
      topology: EXTENDED_LIGHTING_TOPOLOGY,
      reason: `maxTextureArrayLayers ${maxLayers} < ${IES_SLICE_CAPACITY}`,
    };
  }
  if (maxUniformBuffers < 1) {
    return {
      admitted: false,
      topology: EXTENDED_LIGHTING_TOPOLOGY,
      reason: `maxUniformBuffersPerShaderStage ${maxUniformBuffers} < 1`,
    };
  }
  if (
    !device.caps.storageBuffer ||
    !device.caps.rgba16floatRenderable ||
    !device.caps.samplerAliasing
  ) {
    return {
      admitted: false,
      topology: EXTENDED_LIGHTING_TOPOLOGY,
      reason: 'required storage-buffer, rgba16float, or sampler capability is unavailable',
    };
  }
  return { admitted: true, topology: EXTENDED_LIGHTING_TOPOLOGY, reason: undefined };
}
