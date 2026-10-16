/** Five atmosphere textures extend the full physical Standard layout of 26. */
export const ATMOSPHERE_REQUIRED_SAMPLED_TEXTURES = 31;
export function atmosphereAvailable(
  storageBuffer: boolean,
  maxSampledTextures: number | undefined,
): boolean {
  return storageBuffer && (maxSampledTextures ?? 0) >= ATMOSPHERE_REQUIRED_SAMPLED_TEXTURES;
}
