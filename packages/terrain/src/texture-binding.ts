/** Ordinary bare/structured identity texture references share one terrain interpretation. */
export function terrainTextureGuid(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'texture' in value &&
    typeof value.texture === 'string'
  )
    return value.texture;
  return undefined;
}
