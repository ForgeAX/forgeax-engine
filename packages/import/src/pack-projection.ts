import { projectPackageCatalog } from '@forgeax/engine-pack/build';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { ImportProduct, PackIndexEntry } from '@forgeax/engine-types';
import { projectImportedAssetPayload } from './import-product.js';
import type { DdcPack } from './import-runner.js';
import { normaliseForPack } from './pack-value.js';
import type { PackBuildProduct } from './scriptable-pack.js';

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

/** Project cooked Pack outputs identically for development and production catalogs. */
export function projectPackBuildCatalog(
  product: PackBuildProduct,
  sourcePath: string,
  packageIdentity: PackageId,
  packageUrl: string,
): PackIndexEntry[] {
  const packageId = PackageId.format(packageIdentity);
  const stagedByGuid = new Map(
    product.stagedOutputs.map((output) => [AssetGuid.format(output.guid).toLowerCase(), output]),
  );
  return projectPackageCatalog(
    product.product.assets.map((asset, sourceIndex) => {
      const staged = stagedByGuid.get(asset.guid.toLowerCase());
      return {
        guid: asset.guid,
        kind: asset.kind,
        sourcePath,
        sourceIndex,
        ...(staged?.sourceKey === undefined ? {} : { sourceKey: staged.sourceKey }),
        refs: asset.refs.map((reference) => reference.guid),
        execution: 'cooked' as const,
        packageId,
        provenance: { provider: 'pack-ts', version: '2.0.0' },
      };
    }),
    packageUrl,
  );
}
