import { ASSET_ERROR_HINTS, AssetError, err } from '@forgeax/engine-types';

export function formatFailure(field: string, reason: string) {
  return err(
    new AssetError({
      code: 'asset-parse-failed',
      expected: 'a finite, bounded mesh supported by the requested interchange format',
      hint: ASSET_ERROR_HINTS['asset-parse-failed'],
      detail: { field, value: reason, reason },
    }),
  );
}
