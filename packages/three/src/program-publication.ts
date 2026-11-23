import { copyRetainedZstdBytes } from '@forgeax/engine-codec';
import { type CookedMaterialRecord, validateCookedMaterialRecord } from '@forgeax/engine-pack';

/** FXM1, followed by a little-endian metadata length, UTF-8 JSON and shader byte windows. */
export const MATERIAL_PUBLICATION_V1 = 0x46584d31;

interface IndexedRecord {
  readonly record: unknown;
  readonly ranges: Record<string, readonly [number, number]>;
}

export function readMaterialPublication(
  bytes: Uint8Array,
  legacyPhysical = false,
): CookedMaterialRecord[] {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indexed = data.byteLength >= 4 && data.getUint32(0) === MATERIAL_PUBLICATION_V1;
  const decoder = new TextDecoder();
  if (!indexed && !legacyPhysical) {
    const records: unknown = JSON.parse(decoder.decode(bytes));
    if (!Array.isArray(records)) throw new Error('Invalid Three material publication');
    return records.map((record) => validateCookedMaterialRecord(record).unwrap());
  }
  const header = indexed ? 8 : 4;
  if (data.byteLength < header) throw new Error('Truncated Three material publication');
  const start = header + data.getUint32(header - 4, true);
  if (start > bytes.length) throw new Error('Invalid Three material metadata length');
  const metadata = JSON.parse(decoder.decode(bytes.subarray(header, start)));
  const entries: IndexedRecord[] = indexed ? metadata : [metadata];
  if (!Array.isArray(entries)) throw new Error('Invalid indexed Three material publication');
  return entries.map(({ record, ranges }) =>
    validateCookedMaterialRecord(record, (path) => {
      const range = ranges[path];
      if (!Array.isArray(range) || range.length !== 2) return undefined;
      const [offset, length] = range;
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 1 ||
        length > bytes.length - start - offset
      )
        return undefined;
      const begin = start + offset;
      const view = bytes.subarray(begin, begin + length);
      copyRetainedZstdBytes(bytes, view, begin);
      return view;
    }).unwrap(),
  );
}
