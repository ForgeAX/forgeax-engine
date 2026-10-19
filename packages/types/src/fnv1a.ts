/** Non-cryptographic FNV-1a recurrence over numeric words (bytes are one case).
 * Word values are XORed as uint32, not reinterpreted as a byte stream. */
export function fnv1a32(values: Iterable<number>): number {
  let hash = 0x811c9dc5;
  for (const value of values) hash = Math.imul(hash ^ value, 0x01000193);
  return hash >>> 0;
}

/** FNV-1a over JavaScript UTF-16 code units, not UTF-8 bytes or code points. */
export function fnv1aUtf16(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++)
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}
