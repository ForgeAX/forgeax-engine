/** Native View layout extension; portable atmosphere reuses the Cluster texture. */
export const ATMOSPHERE_REQUIRED_SAMPLED_TEXTURES = 32;
/** Reduced material variants leave room for the physical sky and medium transport. */
export const ATMOSPHERE_FALLBACK_REQUIRED_SAMPLED_TEXTURES = 16;

export interface AtmosphereFrameAdmissionInput {
  readonly atmosphereAvailable: boolean | undefined;
  readonly backgroundOnly: boolean;
  readonly caps: Readonly<{
    compute: boolean;
    rgba16floatRenderable: boolean;
    storageBuffer: boolean;
    storageTexture: boolean;
  }>;
  readonly limits: Readonly<{
    maxSampledTexturesPerShaderStage?: number;
    maxTextureDimension2D?: number;
    maxTextureDimension3D?: number;
  }>;
}

/**
 * Admit physical atmosphere when the sky volume is supported independently of
 * its Standard-material bindings. Reduced variants omit surface aerial
 * perspective while retaining the physical sky and Skylight response.
 */
export function atmosphereFrameAdmissible(input: AtmosphereFrameAdmissionInput): boolean {
  const { atmosphereAvailable, backgroundOnly, caps, limits } = input;
  if (backgroundOnly && caps.rgba16floatRenderable) return true;

  const sampledTextures = limits.maxSampledTexturesPerShaderStage ?? 0;
  if (
    !caps.storageBuffer &&
    caps.rgba16floatRenderable &&
    (limits.maxTextureDimension2D ?? 0) >= 1024 &&
    sampledTextures >= ATMOSPHERE_FALLBACK_REQUIRED_SAMPLED_TEXTURES
  ) {
    return true;
  }

  const volumeAvailable =
    caps.compute &&
    caps.storageTexture &&
    caps.rgba16floatRenderable &&
    (limits.maxTextureDimension3D ?? 0) >= 32;
  if (!volumeAvailable) return false;
  if (atmosphereAvailable === true) return true;

  return (
    atmosphereAvailable === false &&
    caps.storageBuffer &&
    sampledTextures >= ATMOSPHERE_FALLBACK_REQUIRED_SAMPLED_TEXTURES
  );
}

export function atmosphereAvailable(
  storageBuffer: boolean,
  maxSampledTextures: number | undefined,
): boolean {
  return storageBuffer && (maxSampledTextures ?? 0) >= ATMOSPHERE_REQUIRED_SAMPLED_TEXTURES;
}

/**
 * Backends that compile the PCSS directional receiver. WebGL2 compiles it
 * through shared raw-depth comparisons, and the null backend is a WebGPU
 * double (storage buffers on), so every backend resolves PCSS on. The shader
 * publication relies on this to compile PCSS into every row as a constant.
 */
export function directionalPcssCapable(
  backendKind: 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null',
): boolean {
  return (
    backendKind === 'webgpu' ||
    backendKind === 'wgpu-native' ||
    backendKind === 'wgpu-webgl2' ||
    backendKind === 'null'
  );
}
