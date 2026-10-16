/** Capture-only stub: always invoke create() so pluginPack options are recorded. */
export function optionalAssetPack<T>(_roots: readonly string[], create: () => T): T[] {
  return [create()];
}
