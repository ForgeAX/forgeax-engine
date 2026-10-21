import type { AssetHandle, AssetReferenceOwner } from '@forgeax/engine-types';
import type { AssetRegistry } from '../asset-registry';
import type { CatalogSource } from '../catalog-source';
import type { AssetRecords } from './asset-records';
import type { AdoptedAssetSource, AssetSource } from './asset-source';
import type { DecoderRegistry } from './decoder-registry';

const key = Symbol.for('forgeax.assets.runtime-records');
const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };
if (realm[key] === undefined)
  realm[key] = new WeakMap<
    object,
    {
      records: AssetRecords;
      sources: ReadonlyMap<string, AssetHandle>;
      origins: ReadonlyMap<number, AdoptedAssetSource>;
      decoders: DecoderRegistry;
      source: () => AssetSource | undefined;
    }
  >();
const owners = realm[key] as WeakMap<
  object,
  {
    records: AssetRecords;
    sources: ReadonlyMap<string, AssetHandle>;
    origins: ReadonlyMap<number, AdoptedAssetSource>;
    decoders: DecoderRegistry;
    source: () => AssetSource | undefined;
  }
>;

export function installRuntimeAssets(
  owner: object,
  records: AssetRecords,
  sources: ReadonlyMap<string, AssetHandle>,
  origins: ReadonlyMap<number, AdoptedAssetSource>,
  decoders: DecoderRegistry,
  source: () => AssetSource | undefined,
): void {
  if (owners.has(owner)) throw new TypeError('runtime asset owner is already installed');
  owners.set(owner, { records, sources, origins, decoders, source });
}

/** Fixed publication preparation uses the same installed domain decoders as ordinary loads. */
export function runtimeAssetDecoders(owner: AssetReferenceOwner): DecoderRegistry {
  const decoders = owners.get(owner)?.decoders;
  if (decoders === undefined) throw new TypeError('a runtime asset owner is required');
  return decoders;
}

/** Package-internal borrowed reads. Public Registry reads always return owned copies. */
export function runtimeAssets(owner: AssetReferenceOwner | undefined): AssetRecords {
  const records = owner === undefined ? undefined : owners.get(owner)?.records;
  if (records === undefined) throw new TypeError('a runtime asset owner is required');
  return records;
}

/** Borrow a source identity already adopted by this owner; it grants no new hold. */
export function runtimeAssetReference(
  owner: AssetReferenceOwner,
  guid: string,
): AssetHandle | undefined {
  return owners.get(owner)?.sources.get(guid.toLowerCase());
}

/** Narrow the World reference seam to its installed runtime service for domain work. */
export function runtimeAssetRegistry(owner: AssetReferenceOwner | undefined): AssetRegistry {
  if (owner === undefined || !owners.has(owner))
    throw new TypeError('a runtime asset owner is required');
  return owner as AssetRegistry;
}

export function runtimeAssetSource(owner: AssetReferenceOwner, handle: number): string | undefined {
  return owners.get(owner)?.origins.get(handle)?.guid;
}

/** Reuse I/O only within the exact active source transport owner. */
export function runtimeSourceReader(
  owner: AssetReferenceOwner | undefined,
  catalog: CatalogSource,
): AssetSource | undefined {
  const source = owner === undefined ? undefined : owners.get(owner)?.source();
  return source?.catalogSource === catalog ? source : undefined;
}
