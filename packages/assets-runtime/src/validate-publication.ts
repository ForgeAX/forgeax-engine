import { validateArtifactPath } from '@forgeax/engine-pack/artifact-path';
import type { RuntimePackEnvelope } from '@forgeax/engine-pack/runtime';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import { terrainDerivedClosureValid } from '@forgeax/engine-terrain';
import type { PackageFetcher } from '@forgeax/engine-types';
import {
  type Asset,
  type AssetDecoderContributionRef,
  type AssetDecoderInput,
  AssetError,
  type AssetKind,
  type CatalogEntry,
  err,
  ok,
  type Result,
} from '@forgeax/engine-types';
import type { AssetRegistry } from './asset-registry.js';
import type { CatalogSource } from './catalog-source.js';
import { DecoderRegistry } from './internal/decoder-registry';
import { PackReader } from './internal/pack-reader.js';
import { validatePublicationReferences } from './internal/publication-references.js';
import {
  assertPrivateMeshStorage,
  prepareAssetPayload,
  validateAssetReferences,
} from './prepare-payload.js';
import { artifactUrl, readArtifact } from './registry/artifact-io.js';

export interface PublicationPreparationServices {
  readonly registry?: AssetRegistry;
  readonly shaderRegistry?: ShaderRegistry;
  readonly pack?: RuntimePackEnvelope | undefined;
  readonly decoders?: readonly AssetDecoderContributionRef[];
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
  const decoders = new DecoderRegistry();
  try {
    for (const contribution of services.decoders ?? [])
      decoders.install(contribution.kind as AssetKind<unknown>, contribution.decoder);
    return await preparePublicationPayloads(rows, fetcher, external, services, decoders);
  } finally {
    decoders.dispose();
  }
}

/** Private staging uses the owner's domain loaders; no Catalog or temporary Registry is installed. */
export async function preparePublicationPayloads(
  rows: readonly CatalogEntry[],
  fetcher: PackageFetcher,
  external: { readonly catalog: CatalogSource; readonly fetcher: PackageFetcher } | undefined,
  services: PublicationPreparationServices,
  decoders: DecoderRegistry,
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
    const packs = new Map<string, import('./internal/pack-reader').VerifiedPack>();
    const read: PackageFetcher = async (input, init) => {
      const response = await fetcher(input, init);
      return response.status === 404 && external ? external.fetcher(input, init) : response;
    };
    for (const row of rows) {
      const references = validatePublicationReferences(row.guid, row, (guid) =>
        catalog.get(guid.toLowerCase()),
      );
      if (!references.ok) return references;
      let pack = packs.get(row.packageUrl);
      if (pack === undefined) {
        let input = services.pack;
        if (input === undefined) {
          const response = await read(row.packageUrl);
          if (!response.ok) throw new TypeError('candidate Pack unavailable');
          input = (await response.json()) as RuntimePackEnvelope;
        }
        const tuple = row.publication;
        if (!tuple) throw new TypeError('candidate publication missing');
        const verified = reader.verify(input, { ...tuple, scopeId: input.scopeId });
        if (!verified.ok) return verified;
        pack = verified.value;
        packs.set(row.packageUrl, pack);
      }
      const envelope = pack.assets.find((asset) => asset.guid === row.guid);
      if (!envelope || envelope.kind !== row.kind)
        throw new TypeError('candidate output differs from its Catalog');
      const consumedArtifacts = new Set<string>();
      const input: AssetDecoderInput<unknown> = {
        envelope,
        signal: new AbortController().signal,
        artifacts: {
          locate: (descriptor) => {
            const valid = validateArtifactPath(descriptor.path, {
              packageRoot: row.packageUrl,
              guid: row.guid,
              artifactKey: descriptor.path,
            });
            if (!valid.ok) return undefined;
            consumedArtifacts.add(descriptor.path);
            return artifactUrl(row.packageUrl, valid.value);
          },
          read: async (descriptor) => {
            const result = await readArtifact(
              {
                guid: row.guid,
                packageUrl: row.packageUrl,
                artifactKey: descriptor.path,
                descriptor,
              },
              read,
            );
            if (result.ok) consumedArtifacts.add(descriptor.path);
            return result.ok
              ? result
              : err({
                  code: 'asset-integrity-failed',
                  expected: result.error.expected,
                  hint: result.error.hint,
                  detail: {
                    guid: row.guid,
                    artifactKey: descriptor.path,
                    expectedDigest: descriptor.integrity?.digest ?? 'verified artifact',
                    actualDigest: result.error.code,
                  },
                });
          },
        },
      };
      const loaded = await decoders.loadByKind(row.kind, input);
      if (!loaded.ok) return err(loaded.error);
      // Admission verifies the complete delivered output, including attachments
      // unused by this consumer. A decoder's locate() keeps streaming bodies lazy.
      for (const descriptor of Object.values(envelope.artifacts)) {
        if (consumedArtifacts.has(descriptor.path)) continue;
        const verified = await input.artifacts.read(descriptor);
        if (!verified.ok) return verified;
      }
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
