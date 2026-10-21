import type { AssetDecoderContribution, AssetKind, IesProfileAsset } from '@forgeax/engine-types';
import { AssetError, err, IES_PROFILE_BYTE_LENGTH, ok } from '@forgeax/engine-types';

function isFiniteFloat16(bytes: Uint8Array): boolean {
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    const bits = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
    if (((bits >>> 10) & 0x1f) === 0x1f) return false;
  }
  return true;
}

export function prepareRuntimeIesProfile(value: IesProfileAsset) {
  return value.data instanceof Uint8Array &&
    value.data.byteLength === IES_PROFILE_BYTE_LENGTH &&
    isFiniteFloat16(value.data)
    ? ok(value)
    : err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: 'a complete finite float16 IES profile',
          hint: 'replace the complete prepared photometric profile',
        }),
      );
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

export const iesProfileContribution: AssetDecoderContribution<IesProfileAsset, 'ies-profile'> = {
  kind: { kind: 'ies-profile' } as AssetKind<IesProfileAsset, 'ies-profile'>,
  consumer: 'Render lighting',
  decoder: {
    async decode({ envelope }) {
      const value = readPayload(envelope.payload as unknown as Record<string, unknown>);
      return value === undefined
        ? err({
            code: 'asset-package-invalid',
            expected: 'finite IES profile data',
            hint: 'recook the IES profile',
            detail: { guid: envelope.guid, reason: 'invalid IES profile' },
          })
        : ok(value);
    },
  },
};
