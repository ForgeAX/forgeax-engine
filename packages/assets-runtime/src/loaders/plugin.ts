import { validatePluginAsset } from '@forgeax/engine-pack/runtime';
import type { AssetDecoder, Loader, PluginAsset } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

export const pluginAssetLoader: Loader<PluginAsset> = {
  kind: 'plugin',
  references: 'deferred',
  load(payload) {
    const parsed = validatePluginAsset(payload);
    return parsed.ok ? parsed.value : undefined;
  },
};

export const pluginAssetDecoder: AssetDecoder<PluginAsset> = {
  references: 'deferred',
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
