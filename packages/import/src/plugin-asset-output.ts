import { lowerPluginConfig, validatePluginAssetSource } from '@forgeax/engine-pack/source';
import { err, ImportError, ok } from '@forgeax/engine-types';
import type { AssetOutputInput, AssetOutputProduct } from './scriptable-pack.js';

/** Shared source/config lowering; the host alone resolves program locations. */
export function producePluginAsset(input: AssetOutputInput, program: string) {
  const source = validatePluginAssetSource(input.asset);
  if (!source.ok)
    return err(
      new ImportError({
        code: 'import-internal-error',
        expected: source.error.expected,
        hint: source.error.hint,
        detail: {
          reason: `${input.sourceKey}: ${source.error.detail.path}: ${source.error.detail.reason}`,
        },
      }),
    );
  const config =
    source.value.config === undefined ? undefined : lowerPluginConfig(source.value.config).unwrap();
  return ok({
    payload: {
      kind: 'plugin',
      program,
      ...(config === undefined ? {} : { config: config.config }),
    },
    refs: (config?.refs ?? []).map((guid) => ({ guid, sourceField: { fieldName: 'config' } })),
    artifacts: {},
  } satisfies AssetOutputProduct);
}
