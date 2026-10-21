/** Five atmosphere textures extend the full physical Standard layout of 27. */
export const ATMOSPHERE_REQUIRED_SAMPLED_TEXTURES = 32;
export function atmosphereAvailable(
  storageBuffer: boolean,
  maxSampledTextures: number | undefined,
): boolean {
  return storageBuffer && (maxSampledTextures ?? 0) >= ATMOSPHERE_REQUIRED_SAMPLED_TEXTURES;
}
