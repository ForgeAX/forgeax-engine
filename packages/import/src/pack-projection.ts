import { projectPackageCatalog, sourceOverridesForOutput } from '@forgeax/engine-pack/build';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type {
  AssetPublicationEnvelope,
  ImportProduct,
  PackIndexEntry,
} from '@forgeax/engine-types';
import { projectImportedAssetPayload } from './import-product.js';
import type { DdcPack, RunImportMeta } from './import-runner.js';
import { projectImportPack } from './pack-value.js';
import type { PackBuildProduct } from './scriptable-pack.js';

export function projectImportProductForBuild(
  product: Pick<ImportProduct<unknown>, 'assets'>,
): DdcPack {
  return projectImportPack(product, undefined, projectImportedAssetPayload);
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

export function importSourceKeys(
  subAssets: RunImportMeta['subAssets'],
): ReadonlyMap<string, string> {
  return new Map(
    subAssets.flatMap(({ guid, sourceKey }) =>
      sourceKey === undefined ? [] : [[guid.toLowerCase(), sourceKey] as const],
    ),
  );
}

export interface PublishedImportRows {
  readonly guids: readonly string[];
  readonly packageUrl?: string;
  readonly projection?: Record<string, unknown>;
  readonly publication?: AssetPublicationEnvelope;
  readonly sourcePath?: string;
  readonly revision?: PackIndexEntry['revision'];
  readonly meta?: Pick<RunImportMeta, 'subAssets' | 'sourceOverrides'>;
}

export function publishImportedCatalogRows(
  entries: PackIndexEntry[],
  publication: PublishedImportRows,
  receiptUrls?: ReadonlyMap<string, string>,
): PackIndexEntry[] {
  const { meta, packageUrl, sourcePath, revision } = publication;
  const outputRefs = new Map(
    publication.publication?.outputs.map(({ guid, refs }) => [guid.toLowerCase(), refs]),
  );
  const guids = publication.guids.map((guid) => guid.toLowerCase());
  const selected = new Set(guids);
  const sourceKeys = meta && importSourceKeys(meta.subAssets);
  const published = meta && new Map<string, PackIndexEntry>();
  const fields = {
    ...publication.projection,
    ...(packageUrl === undefined ? {} : { packageUrl }),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(publication.publication === undefined ? {} : { publication: publication.publication }),
    ...(revision === undefined ? {} : { revision }),
  };
  for (const [index, entry] of entries.entries()) {
    const guid = entry.guid.toLowerCase();
    if (!selected.has(guid) || published?.has(guid)) continue;
    const refs = outputRefs.get(guid);
    const cookReceiptUrl = receiptUrls?.get(guid);
    let declared = entry;
    if (meta !== undefined) {
      const { sourceOverrides: _stale, ...rest } = entry;
      declared = {
        ...rest,
        ...sourceOverridesForOutput(meta.sourceOverrides, sourceKeys?.get(guid) ?? entry.sourceKey),
      };
    }
    const row: PackIndexEntry = {
      ...declared,
      ...fields,
      ...(refs === undefined ? {} : { refs }),
      ...(cookReceiptUrl === undefined ? {} : { cookReceiptUrl }),
    };
    entries[index] = row;
    published?.set(guid, row);
  }
  if (!published) return [];
  return guids.flatMap((guid) => {
    const row = published.get(guid);
    return row === undefined ? [] : [row];
  });
}
