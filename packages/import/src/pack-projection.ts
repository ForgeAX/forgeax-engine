import type { ImportProduct } from '@forgeax/engine-types';
import { projectImportedAssetPayload } from './import-product.js';
import type { DdcPack } from './import-runner.js';
import { normaliseForPack } from './pack-value.js';

/** Project one validated import product into the canonical Pack v2 payload. */
export function projectImportProductForBuild(
  product: Pick<ImportProduct<unknown>, 'assets'>,
): DdcPack {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: product.assets.map((asset) => ({
      guid: asset.guid,
      kind: asset.kind,
      ...(asset.name === undefined ? {} : { name: asset.name }),
      payload: normaliseForPack(projectImportedAssetPayload(asset)) as Record<string, unknown>,
      refs: asset.refs.map((reference) => reference.guid),
      artifacts: asset.artifacts,
    })),
  };
}
