/** Compare every byte, retaining undefined and view boundaries. */
export function equalBytes(
  actual: Uint8Array | undefined,
  expected: Uint8Array | undefined,
): boolean;
/** Compare every key and byte without relying on insertion order. */
export function equalByteMaps(
  actual: ReadonlyMap<string, Uint8Array> | undefined,
  expected: ReadonlyMap<string, Uint8Array> | undefined,
): boolean;
