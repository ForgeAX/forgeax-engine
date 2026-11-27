import { semanticBuildKey } from '@forgeax/engine-ddc';
import {
  type CookProduct,
  canonicalScriptableSourcePath,
  finalizeImportProducts,
  ImportError,
  type ImporterRegistry,
  type ImportPublicationInput,
  type ImportRunnerFs,
  importSourceKeys,
  prepareImportedPackPublication,
  publishImportedCatalogRows,
  type RunImportMeta,
  runSourcePackageImport,
  type SourcePackageBuildDdc,
  type TerminalImportProduct,
} from '@forgeax/engine-import';
import { type CatalogBuildResult, RUNTIME_PACK_SUFFIX } from '@forgeax/engine-pack/build';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type {
  ImportedAsset,
  ImportProduct,
  PackIndexEntry,
  RuntimeAssetBinding,
} from '@forgeax/engine-types';
import type { PluginServerState } from './plugin-server.js';

interface MetaImportContext {
  readonly ddcRoot: (cwd: string, binding?: RuntimeAssetBinding) => string;
  readonly runtimeBinding?: RuntimeAssetBinding;
  readonly getCatalogProjection: () => CatalogBuildResult;
  readonly setCatalogProjection: (projection: CatalogBuildResult) => void;
  readonly metaPackBodies: PluginServerState['metaPackBodies'];
  readonly devArtifactBodies: Map<
    string,
    { readonly bytes: Uint8Array; readonly mimeType: string }
  >;
  readonly importerRegistry: ImporterRegistry;
  readonly cookers?: readonly NativeCooker[] | undefined;
  readonly fsForImport: ImportRunnerFs;
  readonly sourcePackageDdc?: SourcePackageBuildDdc;
  readonly cookedProjection: Record<string, unknown>;
  readonly pendingImportPublications: Map<string, ImportPublicationInput>;
  readonly declaration: RunImportMeta;
  readonly signal?: AbortSignal;
}

const DEV_PACK_PREFIX = '/__forgeax-ddc/';

function assertImportOpen(context: Pick<MetaImportContext, 'signal'>, metaPath: string): void {
  if (!context.signal?.aborted) return;
  throw new ImportError({
    code: 'import-internal-error',
    expected: `the import for ${metaPath} to finish before the dev session closes`,
    hint: 'discard the aborted import and retry after the next generation is serving',
    detail: { reason: 'dev session aborted' },
  });
}

/**
 * This entry stores the runtime Pack envelope, not only CookProduct bytes. A
 * relocated source can keep identical artifacts while its publication
 * generation changes; those envelopes must not share an immutable DDC key.
 * Keep old entries intact and key all envelope inputs.
 */
function runtimePackKey(
  meta: RunImportMeta,
  scopeId: string,
  sourceRevision: string,
  cookProducts: readonly CookProduct[],
  routeDigest: string | null,
): string {
  const cookedDigest = cookProducts
    .map((product) => `${product.guid.toLowerCase()}=${product.digest}`)
    .sort()
    .join('|');
  return semanticBuildKey({
    schemaVersion: '2.0.0',
    importerVersion: meta.importer,
    codecVersion: 'pack-v2-runtime-publication',
    sourceDependencies: [{ path: meta.source, digest: cookedDigest }],
    settings: {
      importSettings: meta.importSettings ?? {},
      publication: {
        scopeId,
        sourceRevision,
        digest: routeDigest,
        sourceKeys: meta.subAssets.map((sub) => ({
          guid: sub.guid.toLowerCase(),
          sourceKey: sub.sourceKey ?? sub.guid,
        })),
      },
    },
    declaredGuids: meta.subAssets.map((sub) => sub.guid),
    cookProfile: 'dev',
    ...(meta.sourceOverrides === undefined ? {} : { sourceOverrides: meta.sourceOverrides }),
  });
}

/** One publication output per transport asset, carrying its CookProduct digest. */
function publicationOutputs(
  assets: readonly ImportedAsset<unknown>[],
  cookProducts: readonly CookProduct[],
  meta: RunImportMeta,
) {
  const outputByGuid = new Map(
    cookProducts.map((product) => [product.guid.toLowerCase(), product]),
  );
  const sourceKeys = importSourceKeys(meta.subAssets);
  return assets.map((asset) => {
    const product = outputByGuid.get(asset.guid.toLowerCase());
    if (product === undefined) {
      throw new ImportError({
        code: 'import-internal-error',
        expected: `the importer to retain CookProduct evidence for ${asset.guid}`,
        hint: 'preserve the complete producer output set before publishing the runtime tuple',
        detail: { reason: `missing CookProduct: ${asset.guid}` },
      });
    }
    return {
      guid: asset.guid,
      sourceKey: sourceKeys.get(asset.guid.toLowerCase()) ?? asset.guid,
      kind: asset.kind,
      digest: product.digest,
      refs: asset.refs.map((ref) => ref.guid),
    };
  });
}

function importRoute(meta: RunImportMeta) {
  const guid = meta.subAssets[0]?.guid?.toLowerCase();
  return guid === undefined
    ? undefined
    : { guid, packUrl: `${DEV_PACK_PREFIX}${guid}${RUNTIME_PACK_SUFFIX}` };
}

/**
 * Catalog rows own the stable source identity (the imported file), while
 * `metaPath` is only the sidecar declaration used to drive this import.
 * Publication fences must use the same source path as that row or a save
 * racing the Catalog handoff can persist one tuple and reopen against
 * another (`*.glb` versus `*.glb.meta.json`).
 *
 * The inventory may be rooted outside the process cwd (standalone games are
 * commonly temporary directories), so its raw relative path can contain
 * `../../.../sample/assets`. Runtime consumers use game-relative `assets/...`
 * coordinates; canonicalize both the row and publication before exposing
 * this generation to the Catalog replica.
 */
function publicationSourcePathOf(
  catalog: readonly PackIndexEntry[],
  routeGuid: string | undefined,
  meta: RunImportMeta,
): string {
  const catalogSourcePath =
    routeGuid === undefined
      ? undefined
      : catalog.find((entry) => entry.guid.toLowerCase() === routeGuid)?.sourcePath;
  return canonicalScriptableSourcePath(catalogSourcePath ?? meta.source);
}

export type PreparedMetaImport =
  | { readonly skipped: true }
  | { readonly product: TerminalImportProduct; readonly cookProducts: readonly CookProduct[] };

/** Prepare the detached source product before reading or mutating Catalog state. */
export async function prepareMetaImport(
  metaPath: string,
  meta: RunImportMeta,
  context: Pick<
    MetaImportContext,
    'importerRegistry' | 'fsForImport' | 'cookers' | 'sourcePackageDdc' | 'signal'
  >,
): Promise<PreparedMetaImport> {
  assertImportOpen(context, metaPath);
  const runResult = await runSourcePackageImport({
    meta,
    registry: context.importerRegistry,
    fs: context.fsForImport,
    ...(context.cookers === undefined ? {} : { cookers: context.cookers }),
    ...(context.sourcePackageDdc === undefined ? {} : { ddc: context.sourcePackageDdc }),
  });
  assertImportOpen(context, metaPath);
  if (!runResult.ok) throw runResult.error;
  if ('skipped' in runResult.value) return { skipped: true };
  const { product } = runResult.value;
  const cookProducts =
    runResult.value.cookProducts ?? (await finalizeImportProducts(product, product.sourceRevision));

  return { product, cookProducts };
}

async function prepareRoutedImport(
  route: NonNullable<ReturnType<typeof importRoute>>,
  context: MetaImportContext,
  product: ImportProduct<unknown>,
  sourceRevision: string,
  sourcePath: string,
  cookProducts: readonly CookProduct[],
) {
  const meta = context.declaration;
  const finalize = context.importerRegistry.get(meta.importer)?.finalize;
  const scopeId = context.runtimeBinding?.scopeId ?? 'asset-runtime';
  const finalizedProduct = await prepareImportedPackPublication(
    product,
    {
      base: '/',
      packagePath: route.packUrl.slice(1),
      artifactPath: (guid, key) => `${guid}/${key}.bin`,
    },
    (finalized, transportProduct) => ({
      scopeId,
      sourcePath,
      sourceRevision,
      packageUrl: route.packUrl,
      inputFingerprint: runtimePackKey(
        meta,
        scopeId,
        sourceRevision,
        cookProducts,
        finalized.digest,
      ),
      outputs: publicationOutputs(transportProduct.assets, cookProducts, meta),
    }),
    finalize === undefined
      ? undefined
      : {
          finalize,
          artifactUrl: (artifact) => `${DEV_PACK_PREFIX}${route.guid}/${artifact.path}`,
        },
  );
  if (!finalizedProduct.ok) {
    const detail = finalizedProduct.error.detail;
    throw new ImportError({
      code: 'import-internal-error',
      expected: finalizedProduct.error.expected,
      hint: finalizedProduct.error.hint,
      detail: {
        reason:
          detail !== null &&
          typeof detail === 'object' &&
          'token' in detail &&
          typeof detail.token === 'string'
            ? detail.token
            : finalizedProduct.error.code,
      },
    });
  }
  return {
    ...route,
    ...finalizedProduct.value,
    desiredKey: finalizedProduct.value.publication.receipt.inputFingerprint,
  };
}

export async function startMetaImport(
  metaPath: string,
  context: MetaImportContext,
  prepared?: PreparedMetaImport,
): Promise<PackIndexEntry[]> {
  assertImportOpen(context, metaPath);
  const previousCatalog = context.getCatalogProjection().entries;
  const catalog = [...previousCatalog];
  const meta = context.declaration;
  const imported = prepared ?? (await prepareMetaImport(metaPath, meta, context));
  if ('skipped' in imported) return [];
  const { product, cookProducts } = imported;

  const route = importRoute(meta);
  const publicationSourcePath = publicationSourcePathOf(catalog, route?.guid, meta);
  const routed =
    route === undefined
      ? undefined
      : await prepareRoutedImport(
          route,
          context,
          product,
          product.sourceRevision,
          publicationSourcePath,
          cookProducts,
        );
  assertImportOpen(context, metaPath);
  // No await separates these rows from the abort check above.
  const allEntries = publishImportedCatalogRows(catalog, {
    meta,
    guids: meta.subAssets.map((sub) => sub.guid),
    sourcePath: publicationSourcePath,
    ...(routed === undefined
      ? {}
      : {
          packageUrl: routed.packUrl,
          projection: context.cookedProjection,
          publication: routed.publication,
        }),
  });
  context.setCatalogProjection({ ...context.getCatalogProjection(), entries: catalog });

  if (routed === undefined) return allEntries;
  const { guid, pack, desiredKey, artifacts } = routed;
  const root = context.ddcRoot(process.cwd(), context.runtimeBinding);
  context.metaPackBodies.set(routed.packUrl, {
    text: JSON.stringify(pack),
    artifactPaths: artifacts.map((artifact) => artifact.path),
  });
  const publicationInput: ImportPublicationInput = {
    root,
    guid,
    desiredKey,
    pack,
    previousCatalog,
    nextCatalog: catalog,
    publishedGuids: allEntries.map((entry) => entry.guid),
    artifacts: artifacts.map(({ path, mediaType, bytes }) => ({ path, mediaType, bytes })),
  };
  // The production owner acquires DDC leases at commit, after every producer
  // has staged its output. Synchronous cook work can outlive a lease heartbeat.
  context.pendingImportPublications.set(`${metaPath}\0${desiredKey}`, publicationInput);
  for (const artifact of artifacts) {
    context.devArtifactBodies.set(`${DEV_PACK_PREFIX}${artifact.path}`, {
      bytes: artifact.bytes,
      mimeType: artifact.mediaType,
    });
  }
  return allEntries;
}
