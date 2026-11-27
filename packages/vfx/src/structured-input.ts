import { err, ok, type Result } from '@forgeax/engine-types';
import type { VfxDataInterfaceError } from './data-interface.js';

export const VFX_STRUCTURED_INPUT_BYTES_LIMIT = 64 * 1024;
export function isVfxStructuredInputData(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array &&
    value.buffer instanceof ArrayBuffer &&
    value.byteLength >= 16 &&
    value.byteLength <= VFX_STRUCTURED_INPUT_BYTES_LIMIT &&
    value.byteLength % 16 === 0
  );
}
function invalid(message: string): VfxDataInterfaceError {
  return {
    code: 'vfx-data-interface-wrong-type',
    expected: message,
    hint: 'publish bounded author observations rather than particle state',
    detail: { token: 'vfx:structured-input' },
  };
}
export interface VfxStructuredInputBank {
  readonly recordStrideBytes: number;
  readonly capacity: number;
  write(index: number, bytes: Uint8Array): Result<void, VfxDataInterfaceError>;
  clear(index?: number): Result<void, VfxDataInterfaceError>;
  /** A detached source version; later writes and disposal cannot change it. */
  snapshot(): Uint8Array | undefined;
  dispose(): void;
}
/** CPU author observations; allocation and upload of GPU storage stay in Render. */
export function createVfxStructuredInputBank(options: {
  readonly recordStrideBytes: number;
  readonly capacity: number;
}): Result<VfxStructuredInputBank, VfxDataInterfaceError> {
  const { recordStrideBytes, capacity } = options;
  const size = recordStrideBytes * capacity;
  if (
    !Number.isSafeInteger(recordStrideBytes) ||
    recordStrideBytes < 16 ||
    recordStrideBytes % 16 !== 0 ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    !Number.isSafeInteger(size) ||
    size > VFX_STRUCTURED_INPUT_BYTES_LIMIT
  )
    return err(invalid('a positive 16-aligned record stride and capacity within 64 KiB'));
  let data: Uint8Array | undefined = new Uint8Array(size);
  const validIndex = (index: number) =>
    Number.isSafeInteger(index) && index >= 0 && index < capacity;
  return ok({
    recordStrideBytes,
    capacity,
    write(index, bytes) {
      if (!data) return err(invalid('a live structured input bank'));
      if (
        !validIndex(index) ||
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength !== recordStrideBytes
      )
        return err(invalid('an in-range record and exact record byte count'));
      data.set(bytes, index * recordStrideBytes);
      return ok(undefined);
    },
    clear(index) {
      if (!data) return err(invalid('a live structured input bank'));
      if (index === undefined) {
        data.fill(0);
        return ok(undefined);
      }
      if (!validIndex(index)) return err(invalid('an in-range record index'));
      data.fill(0, index * recordStrideBytes, (index + 1) * recordStrideBytes);
      return ok(undefined);
    },
    snapshot: () => data?.slice(),
    dispose() {
      data = undefined;
    },
  });
}
