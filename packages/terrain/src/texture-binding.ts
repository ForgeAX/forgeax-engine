/** Ordinary bare/structured identity texture references share one terrain interpretation. */
export function terrainTextureGuid(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'texture' in value &&
    (typeof value.texture === 'string' || typeof value.texture === 'number')
  )
    return String(value.texture);
  return undefined;
}
