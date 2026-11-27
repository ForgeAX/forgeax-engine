/** Shared bounds for detached receipt-owned CPU observation trees. */
export const MAX_RECEIPT_OBSERVATION_BYTES = 16 * 1024;
export const MAX_INSPECTION_SAMPLES = 64;

/** A detached JSON row adds its own UTF-8 bytes and at most one comma to the array. */
export function appendedObservationBytes(arrayBytes: number, row: object): number {
  const json = JSON.stringify(row);
  let bytes = arrayBytes + (arrayBytes === 2 ? 0 : 1) + json.length;
  if (bytes > MAX_RECEIPT_OBSERVATION_BYTES) return bytes;
  const first = json.search(/[\u0080-\uffff]/);
  if (first < 0) return bytes;
  // JSON escapes lone surrogates. A pair occupies two UTF-16 units and four UTF-8 bytes.
  for (let i = first; i < json.length; i++) {
    const unit = json.charCodeAt(i);
    if (unit >= 0x800) {
      bytes += 2;
      if (unit >= 0xd800 && unit <= 0xdbff) i++;
    } else if (unit >= 0x80) bytes++;
  }
  return bytes;
}
