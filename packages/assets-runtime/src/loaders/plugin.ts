import { validatePluginAsset } from '@forgeax/engine-pack/runtime';
import type { AssetDecoder, PluginAsset } from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';

export const pluginAssetDecoder: AssetDecoder<PluginAsset> = {
  references: 'deferred',
  prepare(input) {
    const parsed = validatePluginAsset(input);
    return parsed.ok
      ? ok(parsed.value)
      : err(
          new AssetError({
            code: 'asset-invalid-value',
            expected: parsed.error.expected,
            hint: parsed.error.hint,
          }),
        );
  },
  async decode({ envelope }) {
    const parsed = validatePluginAsset(envelope.payload);
    return parsed.ok
      ? ok(parsed.value)
      : err({
          code: 'asset-decode-failed',
          expected: parsed.error.expected,
          hint: parsed.error.hint,
          detail: { guid: envelope.guid, kind: 'plugin' },
        });
  },
};
