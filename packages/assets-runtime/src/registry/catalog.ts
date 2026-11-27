import {
  type CatalogNavigationRow,
  decodeCatalogWire,
  readCatalogNavigationRow,
} from '@forgeax/engine-pack/runtime';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  type ResourceRevision,
  type RuntimeAssetBinding,
} from '@forgeax/engine-types';
import { jsonOf, type PackageFetcher, readPackage } from '../internal/package-read.js';

function parseError(
  expected: string,
  detail?: object,
  hint = ASSET_ERROR_HINTS['asset-parse-failed'],
): AssetError {
  return new AssetError({
    code: 'asset-parse-failed',
    expected,
    hint,
    ...(detail === undefined ? {} : { detail: detail as never }),
  });
}

function sameRevision(left: ResourceRevision, right: ResourceRevision): boolean {
  return (
    left.digest === right.digest &&
    left.observedAt === right.observedAt &&
    left.rootId === right.rootId
  );
}

export function checkExpectedRevision(
  records: readonly Pick<CatalogNavigationRow, 'revision'>[],
  expectedRevision: ResourceRevision | undefined,
  requireObservation = false,
): AssetError | undefined {
  if (expectedRevision === undefined || (!requireObservation && records.length === 0))
    return undefined;
  const actualRevisions = records.flatMap((record) =>
    record.revision === undefined ? [] : [record.revision],
  );
  if (
    actualRevisions.length > 0 &&
    actualRevisions.every((revision) => sameRevision(revision, expectedRevision))
  ) {
    return undefined;
  }
  return parseError(
    requireObservation
      ? 'static catalog entries to carry the expected producer revision'
      : 'every catalog entry to carry the expected producer revision',
    { expectedRevision, actualRevisions },
    'restore a verified catalog revision before applying the source',
  );
}

/** Resolve a catalog entry URL against the configured pack-index URL. */
export function resolveCatalogAssetUrl(
  registry: { readonly packIndexUrl: string | undefined },
  packageUrl: string,
): string {
  const packIndexUrl = registry.packIndexUrl;
  if (packIndexUrl === undefined) return packageUrl;

  try {
    const baseUrl = new URL(packIndexUrl, globalThis.location?.href).href;
    return new URL(packageUrl, baseUrl).href;
  } catch {
    return packageUrl;
  }
}

function scopedSnapshotError(
  raw: unknown,
  expectedScope: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>,
): AssetError | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return parseError(
      'scoped catalog snapshot to be an object with schema, scopeId, generation, authority, and entries',
    );
  }
  const snapshot = raw as Record<string, unknown>;
  if (
    snapshot.schemaVersion !== 'runtime-catalog-snapshot-v1' ||
    typeof snapshot.scopeId !== 'string' ||
    typeof snapshot.generation !== 'number' ||
    !Number.isSafeInteger(snapshot.generation)
  ) {
    return parseError('scoped catalog snapshot to satisfy its runtime schema');
  }
  if (
    snapshot.scopeId !== expectedScope.scopeId ||
    snapshot.generation !== expectedScope.generation
  ) {
    return parseError('scoped catalog snapshot to match the active scope and generation', {
      expectedScope,
      actualScope: { scopeId: snapshot.scopeId, generation: snapshot.generation },
    });
  }
  if (snapshot.authority !== 'authoritative') {
    return parseError(
      'scoped catalog snapshot authority to be authoritative before identity lookup',
      { authority: snapshot.authority, diagnostics: snapshot.diagnostics },
      'repair the active game catalog before loading assets',
    );
  }
  return undefined;
}

function resolveRowUrl(
  identity: Pick<CatalogNavigationRow, 'guid' | 'packageUrl'>,
  resolveUrl: (packageUrl: string) => string,
): Result<string, AssetError> {
  try {
    return ok(resolveUrl(identity.packageUrl));
  } catch (error) {
    return err(
      parseError(`catalog entry ${identity.guid} to resolve its packageUrl`, {
        packageUrl: identity.packageUrl,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Parse the shared pack-index/catalog wire shape without loading payloads. */
export function parseCatalog(
  raw: unknown,
  resolveUrl: (packageUrl: string) => string = (packageUrl) => packageUrl,
  expectedRevision?: ResourceRevision,
  expectedScope?: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>,
): Result<readonly CatalogNavigationRow[], AssetError> {
  if (expectedScope !== undefined) {
    const scopeError = scopedSnapshotError(raw, expectedScope);
    if (scopeError !== undefined) return err(scopeError);
  }
  const decoded = decodeCatalogWire(raw);
  if (!decoded.ok) return decoded;
  const catalog: CatalogNavigationRow[] = [];
  const guids = new Set<string>();
  for (const item of decoded.value) {
    const parsed = readCatalogNavigationRow(item);
    if (!parsed.ok) return parsed;
    const row = parsed.value;
    const rawGuid = row.guid;
    const guid = rawGuid.toLowerCase();
    if (guids.has(guid)) return err(parseError(`catalog GUID ${rawGuid} to be unique`));
    const resolvedUrl = resolveRowUrl(parsed.value, resolveUrl);
    if (!resolvedUrl.ok) return resolvedUrl;
    guids.add(guid);
    catalog.push({ ...row, guid, packageUrl: resolvedUrl.value });
  }
  const revisionError = checkExpectedRevision(catalog, expectedRevision);
  if (revisionError !== undefined) return err(revisionError);
  return ok(catalog);
}

/** Fetch and parse a catalog using the shared JSON/error boundary. */
export async function fetchCatalog(
  url: string,
  fetch: PackageFetcher,
  resolveUrl?: (packageUrl: string) => string,
  expectedRevision?: ResourceRevision,
  expectedScope?: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>,
  requestInit?: { readonly cache?: 'no-store' },
): Promise<
  Result<
    {
      readonly entries: readonly CatalogNavigationRow[];
      readonly scope?: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>;
    },
    AssetError
  >
> {
  const read = await readPackage(fetch, url, jsonOf, requestInit);
  if (!read.ok) {
    return err(
      new AssetError({
        code: 'asset-fetch-failed',
        expected: `${read.error.malformed ? 'JSON' : 'readable'} catalog at ${url}`,
        hint: `${read.error.observed} after ${read.error.attempts} request(s); ${ASSET_ERROR_HINTS['asset-fetch-failed']}`,
        detail: { field: 'request', value: url, reason: read.error.observed },
      }),
    );
  }
  const raw = read.value;
  const parsed = parseCatalog(raw, resolveUrl, expectedRevision, expectedScope);
  if (!parsed.ok) return parsed;
  // parseCatalog has already validated this envelope and its authoritative scope.
  const snapshot = raw as Pick<RuntimeAssetBinding, 'scopeId' | 'generation'> & {
    schemaVersion?: string;
  };
  const scope =
    snapshot?.schemaVersion === 'runtime-catalog-snapshot-v1'
      ? { scopeId: snapshot.scopeId, generation: snapshot.generation }
      : undefined;
  return ok({ entries: parsed.value, ...(scope === undefined ? {} : { scope }) });
}
