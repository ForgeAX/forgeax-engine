import type { FixedPackPublication } from '@forgeax/engine-pack/runtime';
import { createPackageResponse } from '@forgeax/engine-pack/runtime';
import type {
  Asset,
  AssetPublicationOutput,
  CatalogEntry,
  PackageFetcher,
} from '@forgeax/engine-types';
import type { AssetRegistry } from './asset-registry.js';
import { captureAssetPublication } from './capture-publication.js';
import { type CatalogSource, createCatalogSource } from './catalog-source.js';
import { makeLoadContext } from './registry/load-by-guid.js';
import { preparePublicationPayloads } from './validate-publication.js';

type RetainedData = Asset | (() => Promise<Asset>);
interface RetainedAsset {
  readonly row: CatalogEntry;
  readonly asset: RetainedData;
  readonly digest: string;
  readonly generation: number;
  readonly recipe: {
    readonly fixed: FixedPackPublication;
    readonly dependencies: ReadonlyMap<string, RetainedAsset>;
    readonly outputs: readonly AssetPublicationOutput[];
    readonly assets: ReadonlyMap<string, RetainedData>;
  };
}

/** Retain fixed bytes once; domain data is prepared only when a generator actually reads it. */
export async function retainAssetPublications(
  registry: AssetRegistry,
  requested: ReadonlyMap<string, string>,
  entries: readonly CatalogEntry[],
  source: CatalogSource,
  fetcher: PackageFetcher,
  options: Omit<NonNullable<Parameters<typeof captureAssetPublication>[4]>, 'registry'> = {},
): Promise<ReadonlyMap<string, RetainedAsset>> {
  (await registry.ensurePackIndexCache()).unwrap();
  const rows = new Map(entries.map((row) => [row.guid.toLowerCase(), row]));
  const pins = new Map<string, RetainedAsset>();
  const retain = async (guid: string, ancestors = new Set<string>()): Promise<RetainedAsset> => {
    const prior = pins.get(guid);
    if (prior) return prior;
    options.signal?.throwIfAborted();
    const row = rows.get(guid);
    const publication = row?.publication;
    if (!row || !publication) throw new TypeError(`missing dependency publication ${guid}`);
    if (ancestors.has(row.packageUrl)) throw new TypeError('cyclic delivered dependency');
    const fixed = (
      await captureAssetPublication(row, entries, source, fetcher, { ...options, registry })
    ).unwrap();
    const own = new Set(publication.outputs.map((output) => output.guid));
    const dependencies = new Map<string, RetainedAsset>();
    const references = new Set([
      ...publication.outputs.flatMap((output) => output.refs),
      ...publication.externalEvidence.map((edge) => edge.guid),
    ]);
    for (const ref of references) {
      if (own.has(ref)) continue;
      const pin = await retain(ref, new Set([...ancestors, row.packageUrl]));
      const evidence = publication.externalEvidence.find((edge) => edge.guid === ref);
      if (
        (evidence?.digest !== undefined && evidence.digest !== pin.digest) ||
        (evidence?.generation !== undefined && evidence.generation !== pin.generation)
      )
        throw new TypeError(`dependency version changed ${ref}`);
      dependencies.set(ref, pin);
    }
    const assets = new Map<string, RetainedData>();
    const recipe = { fixed, dependencies, assets, outputs: publication.outputs };
    const bound: PackageFetcher = async (input) => {
      const url = String(input);
      const path = [...Object.keys(fixed.blobs)].find(
        (path) => new URL(path, row.packageUrl).href === url,
      );
      if (!path) return createPackageResponse(new Uint8Array(), { status: 404 });
      const bytes = fixed.blobs[path];
      if (!(bytes instanceof Uint8Array))
        throw new TypeError('retained transport bytes are not resident');
      return createPackageResponse(bytes);
    };
    for (const output of publication.outputs) {
      const outputRow = rows.get(output.guid);
      if (!outputRow) throw new TypeError(`missing dependency sibling ${output.guid}`);
      const current = registry.packIndexCache?.get(output.guid)?.publication;
      if (
        current?.generation !== publication.generation ||
        current.digest !== publication.digest ||
        current.outputSetDigest !== publication.outputSetDigest
      )
        throw new TypeError(`dependency changed during retention ${output.guid}`);
      let pending: Promise<Asset> | undefined;
      // Public Ready payloads may have been edited; fixed bytes alone identify this version.
      const data: RetainedData = () => {
        if (!pending)
          pending = (async () => {
            const result = await preparePublicationPayloads(
              [outputRow],
              bound,
              { catalog: createCatalogSource({ entries }), fetcher: bound },
              { pack: fixed.pack, dependencies },
              registry.loaders,
              {
                ...makeLoadContext(registry, bound),
                resolveRef: async (ref) => {
                  const pin = pins.get(ref) ?? dependencies.get(ref);
                  if (!pin) throw new TypeError(`missing retained reference ${ref}`);
                  if (typeof pin.asset === 'function') await pin.asset();
                  return { ok: true, value: 0 } as const;
                },
              },
            );
            const asset = result.unwrap().get(output.guid);
            if (!asset) throw new TypeError(`missing retained payload ${output.guid}`);
            return asset;
          })().catch((error) => {
            pending = undefined;
            throw error;
          });
        return pending;
      };
      assets.set(output.guid, data);
      pins.set(output.guid, {
        asset: data,
        row: outputRow,
        recipe,
        digest: output.digest,
        generation: publication.generation,
      });
    }
    const pin = pins.get(guid);
    if (!pin) throw new TypeError(`missing retained output ${guid}`);
    return pin;
  };
  for (const [guid, digest] of requested) {
    const pin = await retain(guid);
    if (pin.digest !== digest) throw new TypeError(`dependency version differs ${guid}`);
  }
  return new Map([...pins].filter(([guid]) => requested.has(guid)));
}
