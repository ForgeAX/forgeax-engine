import { semanticBuildKey } from '@forgeax/engine-ddc';
import {
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
import type { PackIndexEntry, RuntimeAssetBinding } from '@forgeax/engine-types';
import type { PluginServerState } from './plugin-server.js';

export interface MetaImportContext {
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

export async function startMetaImport(
  metaPath: string,
  context: MetaImportContext,
): Promise<PackIndexEntry[]> {
  assertImportOpen(context, metaPath);
  const previousCatalog = [...context.getCatalogProjection().entries];
  const catalog = [...previousCatalog];
  const previousImportedGuids = new Set(context.importedGuids);
  const meta = context.declaration;
  if (meta === undefined) {
    throw new ImportError({
      code: 'import-internal-error',
      expected: `a validated import declaration for ${metaPath}`,
      hint: IMPORT_ERROR_HINTS['import-internal-error'],
      detail: { reason: `missing import declaration: ${metaPath}` },
    });
  }
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

  const routeSubGuid = meta.subAssets[0]?.guid?.toLowerCase();
  // Catalog rows own the stable source identity (the imported file), while
  // `metaPath` is only the sidecar declaration used to drive this import.
  // Publication fences must use the same source path as that row or a save
  // racing the Catalog handoff can persist one tuple and reopen against
  // another (`*.glb` versus `*.glb.meta.json`).
  const catalogSourcePath =
    routeSubGuid === undefined
      ? undefined
      : catalog.find((entry) => entry.guid.toLowerCase() === routeSubGuid)?.sourcePath;
  // The inventory may be rooted outside the process cwd (standalone games are
  // commonly temporary directories), so its raw relative path can contain
  // `../../.../sample/assets`. Runtime consumers use game-relative `assets/...`
  // coordinates; canonicalize both the row and publication before exposing
  // this generation to the Catalog replica.
  const publicationSourcePath = canonicalScriptableSourcePath(catalogSourcePath ?? meta.source);
  const firstSubGuid = meta.subAssets[0]?.guid?.toLowerCase();
  const packUrl =
    firstSubGuid === undefined ? undefined : `${DEV_PACK_PREFIX}${firstSubGuid}.pack.json`;
  // Capture the accepted body before the transport finalizer stages the new
  // candidate into the live projection. If persistence later fails, this is
  // the LKG body that must be restored; reading it after finalization would
  // capture the failed candidate and make the broken revision look accepted.
  const previousPackBody = packUrl === undefined ? undefined : context.metaPackBodies.get(packUrl);
  const finalizedProduct = await finalizeSourcePackage(
    runResult.value.product,
    routeSubGuid === undefined ? undefined : context.importerRegistry.get(meta.importer)?.finalize,
    (artifact) =>
      `${DEV_PACK_PREFIX}${routeSubGuid ?? meta.subAssets[0]?.guid ?? 'pack'}/${artifact.path}`,
  );
  if (!finalizedProduct.ok) {
    throw new ImportError({
      code: 'import-internal-error',
      expected: finalizedProduct.error.expected,
      hint: finalizedProduct.error.hint,
      detail: {
        reason:
          finalizedProduct.error.detail !== null &&
          typeof finalizedProduct.error.detail === 'object' &&
          'token' in finalizedProduct.error.detail &&
          typeof finalizedProduct.error.detail.token === 'string'
            ? finalizedProduct.error.detail.token
            : finalizedProduct.error.code,
      },
    });
  }
  const transportProduct = finalizedProduct.value;
  const logicalPackage = projectImportProductForBuild(transportProduct);
  const finalizedRoute =
    routeSubGuid === undefined
      ? undefined
      : await finalizePackageTransportSource(logicalPackage, {
          base: '/',
          packagePath: `${DEV_PACK_PREFIX.replace(/^\/+/, '')}${firstSubGuid ?? routeSubGuid}.pack.json`,
          artifactPath: (guid, key) => `${guid}/${key}.bin`,
        });
  assertImportOpen(context, metaPath);

  const cookedDigest = runResult.value.cookProducts
    .map((product) => `${product.guid.toLowerCase()}=${product.digest}`)
    .sort()
    .join('|');
  const desiredKey =
    firstSubGuid === undefined
      ? undefined
      : semanticBuildKey({
          schemaVersion: '2.0.0',
          importerVersion: meta.importer,
          codecVersion: 'pack-v2-runtime-publication',
          sourceDependencies: [{ path: meta.source, digest: cookedDigest }],
          // This entry stores the runtime Pack envelope, not only CookProduct
          // bytes. A relocated source can keep identical artifacts while its
          // publication generation changes; those envelopes must not share an
          // immutable DDC key. Keep old entries intact and key all envelope inputs.
          settings: {
            importSettings: meta.importSettings ?? {},
            publication: {
              scopeId: context.runtimeBinding?.scopeId ?? 'asset-runtime',
              sourceRevision: runResult.value.product.sourceRevision,
              digest: finalizedRoute?.digest ?? null,
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
  const outputByGuid = new Map(
    runResult.value.cookProducts.map((product) => [product.guid.toLowerCase(), product]),
  );
  const publicationOutputs = transportProduct.assets.map((asset) => {
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
  const runtimePublication =
    firstSubGuid === undefined || packUrl === undefined || desiredKey === undefined
      ? undefined
      : createRuntimePackPublication({
          pack: finalizedRoute?.pack ?? projectImportProductForBuild(transportProduct),
          scopeId: context.runtimeBinding?.scopeId ?? 'asset-runtime',
          sourcePath: publicationSourcePath,
          sourceRevision: runResult.value.product.sourceRevision,
          packageUrl: packUrl,
          inputFingerprint: desiredKey,
          ...(finalizedRoute === undefined ? {} : { digest: finalizedRoute.digest }),
          outputs: publicationOutputs,
        });
  const pack =
    runtimePublication?.pack ??
    finalizedRoute?.pack ??
    projectImportProductForBuild(transportProduct);
  const allEntries: PackIndexEntry[] = [];
  if (packUrl !== undefined) context.metaPackBodies.set(packUrl, JSON.stringify(pack));

  const productByGuid = new Map(
    transportProduct.assets.map((asset) => [asset.guid.toLowerCase(), asset]),
  );
  for (const sub of meta.subAssets) {
    assertImportOpen(context, metaPath);
    const guidLower = sub.guid.toLowerCase();
    const raw = catalog.find((entry) => entry.guid.toLowerCase() === guidLower);
    if (raw === undefined) continue;
    const { sourceOverrides: _staleSourceOverrides, ...currentRaw } = raw;
    const currentSourceOverrides =
      meta.sourceOverrides === undefined
        ? {}
        : {
            sourceOverrides: meta.sourceOverrides as NonNullable<PackIndexEntry['sourceOverrides']>,
          };
    const importedAsset = productByGuid.get(guidLower);
    const importedRow: PackIndexEntry = {
      ...currentRaw,
      sourcePath: publicationSourcePath,
      ...currentSourceOverrides,
      ...(packUrl === undefined ? {} : { packageUrl: packUrl, ...context.cookedProjection }),
      ...(runtimePublication === undefined ? {} : { publication: runtimePublication.publication }),
      ...(importedAsset?.refs === undefined
        ? {}
        : { refs: importedAsset.refs.map((ref) => ref.guid) }),
    };
    const index = catalog.findIndex((entry) => entry.guid.toLowerCase() === guidLower);
    if (index >= 0) catalog[index] = importedRow;
    allEntries.push(importedRow);
  }
  context.setCatalogProjection({ ...context.getCatalogProjection(), entries: catalog });

  if (runtimePublication !== undefined && firstSubGuid !== undefined && desiredKey !== undefined) {
    const publicationInput: ImportPublicationInput = {
      root: context.ddcRoot(process.cwd(), context.runtimeBinding),
      guid: firstSubGuid,
      desiredKey,
      pack,
      previousCatalog,
      nextCatalog: catalog,
      publishedGuids: allEntries.map((entry) => entry.guid),
      transport: {
        path: `${context.ddcRoot(process.cwd(), context.runtimeBinding)}/${firstSubGuid}.pack.json`,
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
    // A generation queues validated outputs, not live DDC leases. A subsequent
    // synchronous NativeCook can block heartbeat timers beyond the lease TTL.
    // Acquire each lease only when the generation is ready to commit it.
    const publication =
      context.pendingImportPublications === undefined
        ? await publishImportPublication(publicationInput)
        : undefined;
    context.pendingImportPublications?.set(`${metaPath}\0${desiredKey}`, publicationInput);
    assertImportOpen(context, metaPath);
    if (publication !== undefined && !publication.ok) {
      context.setCatalogProjection({ ...context.getCatalogProjection(), entries: previousCatalog });
      context.importedGuids.clear();
      for (const guid of previousImportedGuids) context.importedGuids.add(guid);
      if (packUrl !== undefined) {
        if (previousPackBody === undefined) context.metaPackBodies.delete(packUrl);
        else context.metaPackBodies.set(packUrl, previousPackBody);
      }
      const previousRows = previousCatalog.filter((entry) =>
        allEntries.some((candidate) => candidate.guid.toLowerCase() === entry.guid.toLowerCase()),
      );
      if (previousRows.length > 0) return previousRows;
      throw new ImportError({
        code: 'import-internal-error',
        expected: publication.error.expected,
        hint: publication.error.hint,
        detail: { reason: publication.error.detail },
      });
    }
    for (const artifact of finalizedRoute?.artifacts ?? []) {
      context.devArtifactBodies.set(`${DEV_PACK_PREFIX}${artifact.path}`, {
        bytes: artifact.bytes,
        mimeType: artifact.mediaType,
      });
    }
    const publishedCatalog = publication?.catalog ?? catalog;
    const delta = calculateCatalogDelta(previousCatalog, publishedCatalog);
    // A production generation publishes its accepted candidate through the
    // outer watcher after every owner commits. Direct route imports have no
    // candidate owner, so they remain responsible for publishing their delta.
    if (delta !== undefined && context.pendingImportPublications === undefined) {
      context.publishCatalogDelta?.(delta);
    }
    context.setCatalogProjection({
      ...context.getCatalogProjection(),
      entries: [...publishedCatalog],
    });
    const publishedRows = new Map(
      publishedCatalog.map((entry) => [entry.guid.toLowerCase(), entry]),
    );
    for (let index = 0; index < allEntries.length; index += 1) {
      const current = allEntries[index];
      const projected =
        current === undefined ? undefined : publishedRows.get(current.guid.toLowerCase());
      if (projected !== undefined) allEntries[index] = projected;
    }
    if (publication?.transportPersisted !== false) {
      for (const entry of allEntries) context.importedGuids.add(entry.guid.toLowerCase());
    } else {
      console.warn('[forgeax-pack] persist DDC pack failed:', {
        code: 'source-package-ddc-persistence-failed',
        guid: firstSubGuid,
        packageUrl: packUrl,
      });
    }
  }
  return allEntries;
}
