import type { RuntimePackEnvelope } from '@forgeax/engine-pack/runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { terrainDerivedClosureValid } from '@forgeax/engine-terrain';
import type { PackageFetcher } from '@forgeax/engine-types';
import {
  type ArtifactDescriptor,
  type Asset,
  AssetError,
  type CatalogEntry,
  err,
  type LoadContext,
  type Loader,
  ok,
  type Result,
} from '@forgeax/engine-types';
import type { AssetRegistry } from './asset-registry.js';
import type { CatalogSource } from './catalog-source.js';
import { PackReader } from './internal/pack-reader.js';
import { validatePublicationReferences } from './internal/publication-references.js';
import type { LoaderRegistry } from './loader-registry.js';
import {
  assertPrivateMeshStorage,
  prepareAssetPayload,
  validateAssetReferences,
} from './prepare-payload.js';
import { readArtifact } from './registry/artifact-io.js';
import { createDefaultLoaderRegistry } from './wire-default-loaders.js';

export interface PublicationPreparationServices {
  readonly registry?: AssetRegistry;
  readonly shaderRegistry?: ShaderRegistry;
  readonly pack?: RuntimePackEnvelope | undefined;
  readonly loaders?: readonly Loader<unknown>[];
  readonly dependencies?: ReadonlyMap<
    string,
    { readonly asset?: unknown; readonly row: CatalogEntry }
  >;
}

/** Adapter for producer injection. App supplies its actual consuming owner. */
export async function validateAssetPublication(
  rows: readonly CatalogEntry[],
  fetcher: PackageFetcher,
  external?: { readonly catalog: CatalogSource; readonly fetcher: PackageFetcher },
  services: PublicationPreparationServices = {},
): Promise<Result<ReadonlyMap<string, Asset | (() => Promise<Asset>)>, unknown>> {
  if (services.registry)
    return services.registry.preparePublication(rows, fetcher, external, services);
  const shaderRegistry = services.shaderRegistry ?? new ShaderRegistry({ manifestUrl: undefined });
  const context: LoadContext = {
    fetchBinary: async (url) => {
      const response = await fetcher(url);
      return response.ok
        ? ok(new Uint8Array(await response.arrayBuffer()))
        : err(
            new AssetError({
              code: 'asset-fetch-failed',
              expected: `asset bytes at ${url}`,
              hint: 'restore the source artifact',
            }),
          );
    },
    resolveRef: async (guid) =>
      services.dependencies?.has(guid) || rows.some((row) => row.guid === guid)
        ? ok(0)
        : err(
            new AssetError({
              code: 'asset-not-found',
              expected: `fixed dependency ${guid}`,
              hint: 'retain the complete dependency closure',
            }),
          ),
    getMaterialShaderTextureFieldNames: (id) => {
      const result = shaderRegistry.findMaterialArtifact(id);
      return result.ok
        ? result.value.paramSchemaProjection.derivedInterface.textureFieldNames
        : undefined;
    },
    device: undefined,
    transcodeCaps: { bc: false, etc2: false, astc: false },
  };
  return preparePublicationPayloads(
    rows,
    fetcher,
    external,
    services,
    createDefaultLoaderRegistry(services.loaders as readonly Loader[] | undefined),
    context,
  );
}

/** Private staging uses the owner's domain loaders; no Catalog or temporary Registry is installed. */
export async function preparePublicationPayloads(
  rows: readonly CatalogEntry[],
  fetcher: PackageFetcher,
  external: { readonly catalog: CatalogSource; readonly fetcher: PackageFetcher } | undefined,
  services: PublicationPreparationServices,
  loaders: LoaderRegistry,
  context: LoadContext,
): Promise<Result<ReadonlyMap<string, Asset>, unknown>> {
  const reader = new PackReader();
  try {
    const base = external ? (await external.catalog.enumerate()).unwrap() : [];
    const catalog = new Map(base.map((row) => [row.guid.toLowerCase(), row]));
    for (const [guid, dependency] of services.dependencies ?? []) catalog.set(guid, dependency.row);
    for (const row of rows) {
      if (services.dependencies?.has(row.guid))
        throw new TypeError('candidate overlaps a retained dependency');
      catalog.set(row.guid, row);
    }
    const prepared = new Map<string, Asset>();
    const packs = new Map<string, RuntimePackEnvelope>();
    const read: PackageFetcher = async (input, init) => {
      const response = await fetcher(input, init);
      return response.status === 404 && external ? external.fetcher(input, init) : response;
    };
    for (const row of rows) {
      const references = validatePublicationReferences(row.guid, row, (guid) =>
        catalog.get(guid.toLowerCase()),
      );
      if (!references.ok) return references;
      let pack = packs.get(row.packageUrl) ?? services.pack;
      if (!pack) {
        const response = await read(row.packageUrl);
        if (!response.ok) throw new TypeError('candidate Pack unavailable');
        pack = (await response.json()) as RuntimePackEnvelope;
      }
      if (!packs.has(row.packageUrl)) {
        const tuple = row.publication;
        if (!tuple) throw new TypeError('candidate publication missing');
        const verified = reader.verify(pack, { ...tuple, scopeId: pack.scopeId });
        if (!verified.ok) return verified;
        packs.set(row.packageUrl, pack);
      }
      const envelope = pack.assets.find((asset) => asset.guid === row.guid);
      if (!envelope || envelope.kind !== row.kind)
        throw new TypeError('candidate output differs from its Catalog');
      const artifacts: Record<string, { descriptor: ArtifactDescriptor; bytes: Uint8Array }> = {};
      for (const [key, raw] of Object.entries(envelope.artifacts)) {
        const descriptor = raw as ArtifactDescriptor;
        const bytes = await readArtifact(
          { guid: row.guid, packageUrl: row.packageUrl, artifactKey: key, descriptor },
          read,
        );
        if (!bytes.ok) return bytes;
        artifacts[key] = { descriptor, bytes: bytes.value };
      }
      const loaded = await loaders.loadPack(
        {
          guid: row.guid,
          kind: row.kind,
          payload: envelope.payload as Record<string, unknown>,
          refs: envelope.refs,
          artifacts,
        },
        context,
      );
      if (!loaded.ok) return err(loaded.error);
      if (
        !loaded.value ||
        typeof loaded.value !== 'object' ||
        !('kind' in loaded.value) ||
        loaded.value.kind !== row.kind
      )
        throw new TypeError('domain loader did not prepare the declared asset kind');
      const result = prepareAssetPayload(loaded.value as Asset);
      if (!result.ok) return result;
      if (result.value.kind === 'mesh') assertPrivateMeshStorage(result.value);
      prepared.set(row.guid, result.value);
    }
    for (const row of rows) {
      const asset = prepared.get(row.guid);
      const envelope = packs.get(row.packageUrl)?.assets.find((entry) => entry.guid === row.guid);
      if (!asset || !envelope) throw new TypeError(`missing prepared output ${row.guid}`);
      const refs = envelope.refs.map((guid) => ({ guid }));
      for (const ref of refs)
        if (!catalog.has(ref.guid)) throw new TypeError(`missing candidate dependency ${ref.guid}`);
      const error = validateAssetReferences(
        asset,
        row.guid,
        refs,
        (guid) => prepared.get(guid)?.kind ?? catalog.get(guid.toLowerCase())?.kind,
      );
      if (error) return err(error);
    }
    // Geometry is validated while all outputs are still private. A failed derived
    // texture must not displace the currently accepted publication.
    for (const asset of prepared.values()) {
      if (asset.kind !== 'terrain') continue;
      const closure = new Map<string, Asset>([
        ...[...(services.dependencies ?? [])].map(
          ([guid, value]) => [guid, value.asset as Asset] as const,
        ),
        ...prepared,
      ]);
      if (!terrainDerivedClosureValid(asset, closure))
        throw new TypeError(
          'terrain derived geometry/height/control/layer closure differs from its author samples',
        );
    }
    return ok(prepared);
  } catch (cause) {
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: 'a complete domain-valid candidate publication',
        hint: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  } finally {
    reader.dispose();
  }
}
