import { err, ok, type Result, RhiError } from './errors';

/** Source range in bytes, relative to the supplied view rather than its backing buffer. */
export function bufferWriteRange(
  data: ArrayBufferView | ArrayBuffer,
  dataOffset = 0,
  size?: number,
): Result<{ readonly byteOffset: number; readonly byteLength: number }, RhiError> {
  const elementBytes =
    ArrayBuffer.isView(data) && 'BYTES_PER_ELEMENT' in data
      ? (data as ArrayBufferView & { readonly BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
      : 1;
  const elements = data.byteLength / elementBytes;
  const count = size ?? elements - dataOffset;
  if (
    !Number.isSafeInteger(dataOffset) ||
    dataOffset < 0 ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    dataOffset + count > elements ||
    (count * elementBytes) % 4 !== 0
  ) {
    return err(
      new RhiError({
        code: 'queue-write-buffer-out-of-bounds',
        expected: 'an in-bounds source element range whose byte length is a multiple of four',
        hint: `dataOffset=${dataOffset}; size=${String(size)}; elements=${elements}; elementBytes=${elementBytes}`,
      }),
    );
  }
  return ok({ byteOffset: dataOffset * elementBytes, byteLength: count * elementBytes });
}
