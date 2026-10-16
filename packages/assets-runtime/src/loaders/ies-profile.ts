import type { IesProfileAsset, Loader } from '@forgeax/engine-types';
import { IES_PROFILE_BYTE_LENGTH } from '@forgeax/engine-types';

function isFiniteFloat16(bytes: Uint8Array): boolean {
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    const bits = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
    if (((bits >>> 10) & 0x1f) === 0x1f && (bits & 0x03ff) !== 0) return false;
  }
  return true;
}

function readPayload(payload: Record<string, unknown>): IesProfileAsset | undefined {
  if (payload.kind !== 'ies-profile') return undefined;
  const data = payload.data;
  const bytes =
    data instanceof Uint8Array
      ? data
      : Array.isArray(data) &&
          data.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
        ? Uint8Array.from(data)
        : undefined;
  if (bytes === undefined || bytes.byteLength !== IES_PROFILE_BYTE_LENGTH) return undefined;
  return isFiniteFloat16(bytes) ? { kind: 'ies-profile', data: bytes } : undefined;
}

export const iesProfileLoader = {
  kind: 'ies-profile',
  load(payload, _refs, _ctx) {
    const value = readPayload(payload);
    return value;
  },
} satisfies Loader<IesProfileAsset>;
