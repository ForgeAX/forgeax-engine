/** Five atmosphere textures extend the full physical Standard layout of 27. */
export const ATMOSPHERE_REQUIRED_SAMPLED_TEXTURES = 32;
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
