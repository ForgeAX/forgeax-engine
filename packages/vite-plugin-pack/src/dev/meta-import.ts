import { semanticBuildKey } from '@forgeax/engine-ddc';
import {
  type CookProduct,
  canonicalScriptableSourcePath,
  finalizeSourcePackage,
  IMPORT_ERROR_HINTS,
  ImportError,
  type ImporterRegistry,
  type ImportPublicationInput,
  type ImportRunnerFs,
  projectImportProductForBuild,
  publishImportPublication,
  type RunImportMeta,
  runImport,
} from '@forgeax/engine-import';
import {
  type CatalogBuildResult,
  calculateCatalogDelta,
  createRuntimePackPublication,
  finalizePackageTransportSource,
} from '@forgeax/engine-pack/build';
import { type NativeCooker, NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
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
  readonly importedGuids: Set<string>;
  readonly metaPackBodies: PluginServerState['metaPackBodies'];
  readonly devArtifactBodies: Map<
    string,
    { readonly bytes: Uint8Array; readonly mimeType: string }
  >;
  readonly importerRegistry: ImporterRegistry;
  readonly cookers?: readonly NativeCooker[] | undefined;
  readonly fsForImport: ImportRunnerFs;
  readonly publishCatalogDelta:
    | ((delta: import('@forgeax/engine-types').CatalogDelta) => void)
    | undefined;
  readonly cookedProjection: Record<string, unknown>;
  readonly pendingImportPublications?: Map<string, ImportPublicationInput>;
  /** Validated by the Pack inventory; absent only for on-demand route misses. */
  readonly declaration?: RunImportMeta;
  readonly signal?: AbortSignal;
}

const DEV_PACK_PREFIX = '/__forgeax-ddc/';

function assertImportOpen(context: MetaImportContext, metaPath: string): void {
  if (!context.signal?.aborted) return;
  throw new ImportError({
    code: 'import-internal-error',
    expected: `the import for ${metaPath} to finish before the dev session closes`,
    hint: 'discard the aborted import and retry after the next generation is serving',
    detail: { reason: 'dev session aborted' },
  });
}

function requireImportDeclaration(context: MetaImportContext, metaPath: string): RunImportMeta {
  const meta = context.declaration;
  if (meta === undefined) {
    throw new ImportError({
      code: 'import-internal-error',
      expected: `a validated import declaration for ${metaPath}`,
      hint: IMPORT_ERROR_HINTS['import-internal-error'],
      detail: { reason: `missing import declaration: ${metaPath}` },
    });
  }
  return meta;
}

/** Runs the importer's route finalizer; only a routed import has one. */
async function finalizeImportTransport(
  product: ImportProduct<unknown>,
  meta: RunImportMeta,
  context: MetaImportContext,
  routeGuid: string | undefined,
): Promise<ImportProduct<unknown>> {
  const finalizedProduct = await finalizeSourcePackage(
    product,
    routeGuid === undefined ? undefined : context.importerRegistry.get(meta.importer)?.finalize,
    (artifact) =>
      `${DEV_PACK_PREFIX}${routeGuid ?? meta.subAssets[0]?.guid ?? 'pack'}/${artifact.path}`,
  );
  if (finalizedProduct.ok) return finalizedProduct.value;
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
      sourceKey:
        meta.subAssets.find((sub) => sub.guid.toLowerCase() === asset.guid.toLowerCase())
          ?.sourceKey ?? asset.guid,
      kind: asset.kind,
      digest: product.digest,
      refs: asset.refs.map((ref) => ref.guid),
    };
  });
}

/**
 * A routed import (one with a first sub-asset) serves its dev pack at `packUrl`
 * and restores the accepted serving state when its publication commit fails.
 */
interface ImportRoute {
  readonly guid: string;
  readonly packUrl: string;
  readonly acceptedCatalog: CatalogBuildResult['entries'];
  readonly acceptedImportedGuids: ReadonlySet<string>;
  readonly acceptedPackBody: string | Uint8Array | undefined;
}

/**
 * Capture the accepted body before the transport finalizer stages the new
 * candidate into the live projection. If persistence later fails, this is
 * the LKG body that must be restored; reading it after finalization would
 * capture the failed candidate and make the broken revision look accepted.
 */
function importRoute(
  meta: RunImportMeta,
  context: MetaImportContext,
  acceptedCatalog: CatalogBuildResult['entries'],
  acceptedImportedGuids: ReadonlySet<string>,
): ImportRoute | undefined {
  const guid = meta.subAssets[0]?.guid?.toLowerCase();
  if (guid === undefined) return undefined;
  const packUrl = `${DEV_PACK_PREFIX}${guid}.pack.json`;
  return {
    guid,
    packUrl,
    acceptedCatalog,
    acceptedImportedGuids,
    acceptedPackBody: context.metaPackBodies.get(packUrl),
  };
}

function restoreAcceptedImport(context: MetaImportContext, route: ImportRoute): void {
  context.setCatalogProjection({
    ...context.getCatalogProjection(),
    entries: route.acceptedCatalog,
  });
  context.importedGuids.clear();
  for (const guid of route.acceptedImportedGuids) context.importedGuids.add(guid);
  if (route.acceptedPackBody === undefined) context.metaPackBodies.delete(route.packUrl);
  else context.metaPackBodies.set(route.packUrl, route.acceptedPackBody);
}

/** Replaces each declared sub-asset's Catalog row in place; returns the imported rows. */
function replaceImportedRows(
  catalog: PackIndexEntry[],
  meta: RunImportMeta,
  rowFields: Partial<PackIndexEntry>,
  assets: readonly ImportedAsset<unknown>[],
): PackIndexEntry[] {
  const productByGuid = new Map(assets.map((asset) => [asset.guid.toLowerCase(), asset]));
  const rows: PackIndexEntry[] = [];
  for (const sub of meta.subAssets) {
    const guidLower = sub.guid.toLowerCase();
    const raw = catalog.find((entry) => entry.guid.toLowerCase() === guidLower);
    if (raw === undefined) continue;
    const { sourceOverrides: _staleSourceOverrides, ...currentRaw } = raw;
    const importedAsset = productByGuid.get(guidLower);
    const importedRow: PackIndexEntry = {
      ...currentRaw,
      ...rowFields,
      ...(importedAsset?.refs === undefined
        ? {}
        : { refs: importedAsset.refs.map((ref) => ref.guid) }),
    };
    const index = catalog.findIndex((entry) => entry.guid.toLowerCase() === guidLower);
    if (index >= 0) catalog[index] = importedRow;
    rows.push(importedRow);
  }
  return rows;
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

/** Fields every imported Catalog row takes from this generation's publication. */
function importedRowFields(
  meta: RunImportMeta,
  sourcePath: string,
  packUrl: string | undefined,
  cookedProjection: Readonly<Record<string, unknown>>,
  publication: PackIndexEntry['publication'],
): Partial<PackIndexEntry> {
  return {
    sourcePath,
    ...(meta.sourceOverrides === undefined
      ? {}
      : {
          sourceOverrides: meta.sourceOverrides as NonNullable<PackIndexEntry['sourceOverrides']>,
        }),
    ...(packUrl === undefined ? {} : { packageUrl: packUrl, ...cookedProjection }),
    ...(publication === undefined ? {} : { publication }),
  };
}

/**
 * Commits a routed generation's publication. A generation queues validated
 * outputs, not live DDC leases. A subsequent synchronous NativeCook can block
 * heartbeat timers beyond the lease TTL. Acquire each lease only when the
 * generation is ready to commit it.
 */
async function commitImportPublication(
  metaPath: string,
  context: MetaImportContext,
  input: ImportPublicationInput,
  route: ImportRoute,
  entries: PackIndexEntry[],
): Promise<PackIndexEntry[]> {
  const publication =
    context.pendingImportPublications === undefined
      ? await publishImportPublication(input)
      : undefined;
  context.pendingImportPublications?.set(`${metaPath}\0${input.desiredKey}`, input);
  assertImportOpen(context, metaPath);
  if (publication !== undefined && !publication.ok) {
    restoreAcceptedImport(context, route);
    const previousRows = route.acceptedCatalog.filter((entry) =>
      entries.some((candidate) => candidate.guid.toLowerCase() === entry.guid.toLowerCase()),
    );
    if (previousRows.length > 0) return previousRows;
    throw new ImportError({
      code: 'import-internal-error',
      expected: publication.error.expected,
      hint: publication.error.hint,
      detail: { reason: publication.error.detail },
    });
  }
  for (const artifact of input.transport?.artifacts ?? []) {
    context.devArtifactBodies.set(`${DEV_PACK_PREFIX}${artifact.path}`, {
      bytes: artifact.bytes,
      mimeType: artifact.mediaType,
    });
  }
  const publishedCatalog = publication?.catalog ?? input.nextCatalog;
  // A production generation publishes its accepted candidate through the
  // outer watcher after every owner commits. Direct route imports have no
  // candidate owner, so they remain responsible for publishing their delta.
  if (context.pendingImportPublications === undefined && context.publishCatalogDelta) {
    const delta = calculateCatalogDelta(route.acceptedCatalog, publishedCatalog);
    if (delta !== undefined) context.publishCatalogDelta(delta);
  }
  context.setCatalogProjection({
    ...context.getCatalogProjection(),
    entries: [...publishedCatalog],
  });
  adoptPublishedRows(entries, publishedCatalog);
  if (publication?.transportPersisted !== false) {
    for (const entry of entries) context.importedGuids.add(entry.guid.toLowerCase());
  } else {
    console.warn('[forgeax-pack] persist DDC pack failed:', {
      code: 'source-package-ddc-persistence-failed',
      guid: route.guid,
      packageUrl: route.packUrl,
    });
  }
  return entries;
}

/** Replaces each imported row with the row the publication actually committed. */
function adoptPublishedRows(
  entries: PackIndexEntry[],
  publishedCatalog: readonly PackIndexEntry[],
): void {
  const publishedRows = new Map(publishedCatalog.map((entry) => [entry.guid.toLowerCase(), entry]));
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index];
    const projected =
      current === undefined ? undefined : publishedRows.get(current.guid.toLowerCase());
    if (projected !== undefined) entries[index] = projected;
  }
}

export async function startMetaImport(
  metaPath: string,
  context: MetaImportContext,
): Promise<PackIndexEntry[]> {
  assertImportOpen(context, metaPath);
  const previousCatalog = [...context.getCatalogProjection().entries];
  const catalog = [...previousCatalog];
  const previousImportedGuids = new Set(context.importedGuids);
  const meta = requireImportDeclaration(context, metaPath);
  const cookers = new NativeCookerRegistry();
  for (const cooker of context.cookers ?? []) cookers.register(cooker);
  const runResult = await runImport(
    { ...meta, buildPack: false },
    context.importerRegistry,
    context.fsForImport,
    cookers,
  );
  assertImportOpen(context, metaPath);
  if (!runResult.ok) throw runResult.error;
  if ('skipped' in runResult.value) return [];
  const { product, cookProducts } = runResult.value;

  const route = importRoute(meta, context, previousCatalog, previousImportedGuids);
  const publicationSourcePath = publicationSourcePathOf(catalog, route?.guid, meta);
  const transportProduct = await finalizeImportTransport(product, meta, context, route?.guid);
  const logicalPackage = projectImportProductForBuild(transportProduct);
  const finalizedRoute =
    route === undefined
      ? undefined
      : await finalizePackageTransportSource(logicalPackage, {
          base: '/',
          packagePath: `${DEV_PACK_PREFIX.replace(/^\/+/, '')}${route.guid}.pack.json`,
          artifactPath: (guid, key) => `${guid}/${key}.bin`,
        });
  assertImportOpen(context, metaPath);

  const scopeId = context.runtimeBinding?.scopeId ?? 'asset-runtime';
  const desiredKey =
    route === undefined
      ? undefined
      : runtimePackKey(
          meta,
          scopeId,
          product.sourceRevision,
          cookProducts,
          finalizedRoute?.digest ?? null,
        );
  const outputs = publicationOutputs(transportProduct.assets, cookProducts, meta);
  const runtimePublication =
    route === undefined || desiredKey === undefined
      ? undefined
      : createRuntimePackPublication({
          pack: finalizedRoute?.pack ?? projectImportProductForBuild(transportProduct),
          scopeId,
          sourcePath: publicationSourcePath,
          sourceRevision: product.sourceRevision,
          packageUrl: route.packUrl,
          inputFingerprint: desiredKey,
          ...(finalizedRoute === undefined ? {} : { digest: finalizedRoute.digest }),
          outputs,
        });
  const pack =
    runtimePublication?.pack ??
    finalizedRoute?.pack ??
    projectImportProductForBuild(transportProduct);
  if (route !== undefined) context.metaPackBodies.set(route.packUrl, JSON.stringify(pack));

  // No await separates these rows from the abort check above.
  const allEntries = replaceImportedRows(
    catalog,
    meta,
    importedRowFields(
      meta,
      publicationSourcePath,
      route?.packUrl,
      context.cookedProjection,
      runtimePublication?.publication,
    ),
    transportProduct.assets,
  );
  context.setCatalogProjection({ ...context.getCatalogProjection(), entries: catalog });

  if (route === undefined || desiredKey === undefined || runtimePublication === undefined)
    return allEntries;
  const publicationInput: ImportPublicationInput = {
    root: context.ddcRoot(process.cwd(), context.runtimeBinding),
    guid: route.guid,
    desiredKey,
    pack,
    previousCatalog,
    nextCatalog: catalog,
    publishedGuids: allEntries.map((entry) => entry.guid),
    transport: {
      path: `${context.ddcRoot(process.cwd(), context.runtimeBinding)}/${route.guid}.pack.json`,
      body: JSON.stringify(pack),
      ...(finalizedRoute === undefined
        ? {}
        : {
            artifacts: finalizedRoute.artifacts.map(({ path, mediaType, bytes }) => ({
              path,
              mediaType,
              bytes,
            })),
          }),
    },
  };
  return commitImportPublication(metaPath, context, publicationInput, route, allEntries);
}
