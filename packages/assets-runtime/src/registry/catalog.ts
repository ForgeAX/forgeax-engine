import { decodeCatalogWire } from '@forgeax/engine-pack/runtime';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  type AssetAuthoringCapability,
  AssetError,
  type AssetPublicationEnvelope,
  type AssetRelation,
  type CatalogDiagnostic,
  type CatalogEntry,
  type CatalogProjection,
  type ProviderProvenance,
  type ResourceRevision,
  type RuntimeAssetBinding,
  type SourceOverrideDescriptor,
  type SourceOverrideMap,
} from '@forgeax/engine-types';
import { jsonOf, type PackageFetcher, readPackage } from '../internal/package-read.js';

/**
 * Runtime catalog row parsed from the shared pack-index POD shape. GUID is the
 * catalog key, and inline assets have no source declaration to navigate.
 */
type CatalogRecord = Omit<CatalogEntry, 'guid' | 'sourcePath'> & {
  readonly sourcePath?: string;
};

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
  records: readonly CatalogRecord[],
  expectedRevision: ResourceRevision | undefined,
): AssetError | undefined {
  if (expectedRevision === undefined || records.length === 0) return undefined;
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
    'every catalog entry to carry the expected producer revision',
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

function isRawSourceLocator(packageUrl: string): boolean {
  const path = packageUrl.split(/[?#]/, 1)[0]?.toLowerCase() ?? packageUrl.toLowerCase();
  if (path.endsWith('.pack.json')) return false;
  return (
    /\.(bin|fbx|gltf|glb|hdr|jpg|jpeg|png|wav|mp3|ogg|ttf|otf|woff|woff2|svg)$/.test(path) ||
    path.endsWith('.particle-effect.json')
  );
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

interface CatalogRowIdentity {
  readonly rawRow: Record<string, unknown>;
  readonly guid: string;
  readonly packageUrl: string;
  readonly kind: string;
}

/** A row must be a navigation-only object naming a cooked package by GUID and kind. */
function catalogRowIdentity(item: unknown): Result<CatalogRowIdentity, AssetError> {
  if (item === null || typeof item !== 'object') {
    return err(parseError('each catalog row to be an object'));
  }
  const rawRow = item as Record<string, unknown>;
  const legacyLocator = ['relative', 'Url'].join('');
  if (
    legacyLocator in rawRow ||
    'metadata' in rawRow ||
    'compression' in rawRow ||
    'artifacts' in rawRow ||
    'assetCodec' in rawRow ||
    'contentEncoding' in rawRow
  ) {
    return err(parseError('catalog rows to expose navigation fields only'));
  }
  const { guid, packageUrl, kind } = rawRow;
  if (
    typeof guid !== 'string' ||
    guid.length === 0 ||
    typeof packageUrl !== 'string' ||
    packageUrl.length === 0 ||
    typeof kind !== 'string' ||
    kind.length === 0
  ) {
    return err(parseError('each catalog row to contain guid, packageUrl, and kind strings'));
  }
  if (isRawSourceLocator(packageUrl)) {
    return err(parseError(`catalog packageUrl ${packageUrl} to identify a cooked package`));
  }
  return ok({ rawRow, guid, packageUrl, kind });
}

function catalogRowFieldError(
  rawRow: Record<string, unknown>,
  guid: string,
): AssetError | undefined {
  const refs = rawRow.refs;
  if (refs !== undefined && (!Array.isArray(refs) || !refs.every((ref) => typeof ref === 'string')))
    return parseError(`catalog refs for GUID ${guid} to be a string array`);
  if (
    rawRow.sourceOverrides !== undefined &&
    (rawRow.sourceOverrides === null ||
      typeof rawRow.sourceOverrides !== 'object' ||
      Array.isArray(rawRow.sourceOverrides))
  ) {
    return parseError(`catalog sourceOverrides for GUID ${guid} to be an object`);
  }
  if (
    rawRow.sourceOverrideDescriptors !== undefined &&
    !Array.isArray(rawRow.sourceOverrideDescriptors)
  ) {
    return parseError(`catalog sourceOverrideDescriptors for GUID ${guid} to be an array`);
  }
  return undefined;
}

function resolveRowUrl(
  identity: CatalogRowIdentity,
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

function catalogNavigationFields(
  rawRow: Record<string, unknown>,
): Pick<
  CatalogRecord,
  'authoring' | 'name' | 'sourcePath' | 'refs' | 'cookReceiptUrl' | 'packageId'
> {
  return {
    ...(rawRow.authoring !== undefined
      ? { authoring: rawRow.authoring as AssetAuthoringCapability }
      : {}),
    ...(typeof rawRow.name === 'string' ? { name: rawRow.name } : {}),
    ...(typeof rawRow.sourcePath === 'string' ? { sourcePath: rawRow.sourcePath } : {}),
    ...(rawRow.refs !== undefined ? { refs: rawRow.refs as readonly string[] } : {}),
    ...(typeof rawRow.cookReceiptUrl === 'string' ? { cookReceiptUrl: rawRow.cookReceiptUrl } : {}),
    ...(typeof rawRow.packageId === 'string' ? { packageId: rawRow.packageId } : {}),
  };
}

function catalogProvenanceFields(
  rawRow: Record<string, unknown>,
): Pick<
  CatalogRecord,
  | 'provenance'
  | 'revision'
  | 'sourceKey'
  | 'sourceIndex'
  | 'sourceOverrides'
  | 'sourceOverrideDescriptors'
  | 'relations'
  | 'diagnostics'
> {
  return {
    ...(rawRow.provenance !== undefined
      ? { provenance: rawRow.provenance as ProviderProvenance }
      : {}),
    ...(rawRow.revision !== undefined ? { revision: rawRow.revision as ResourceRevision } : {}),
    ...(typeof rawRow.sourceKey === 'string' ? { sourceKey: rawRow.sourceKey } : {}),
    ...(typeof rawRow.sourceIndex === 'number' ? { sourceIndex: rawRow.sourceIndex } : {}),
    ...(rawRow.sourceOverrides !== undefined
      ? { sourceOverrides: rawRow.sourceOverrides as SourceOverrideMap }
      : {}),
    ...(rawRow.sourceOverrideDescriptors !== undefined
      ? {
          sourceOverrideDescriptors:
            rawRow.sourceOverrideDescriptors as readonly SourceOverrideDescriptor[],
        }
      : {}),
    ...(Array.isArray(rawRow.relations)
      ? { relations: rawRow.relations as readonly AssetRelation[] }
      : {}),
    ...(Array.isArray(rawRow.diagnostics)
      ? { diagnostics: rawRow.diagnostics as readonly CatalogDiagnostic[] }
      : {}),
  };
}

function catalogLifecycleFields(
  rawRow: Record<string, unknown>,
): Pick<CatalogRecord, 'subject' | 'execution' | 'lifecycle' | 'projection' | 'publication'> {
  return {
    ...(rawRow.subject === 'internal-asset' || rawRow.subject === 'imported-output'
      ? { subject: rawRow.subject }
      : {}),
    ...(rawRow.execution === 'direct' || rawRow.execution === 'cooked'
      ? { execution: rawRow.execution }
      : {}),
    ...(rawRow.lifecycle === 'missing' ||
    rawRow.lifecycle === 'cooking' ||
    rawRow.lifecycle === 'current' ||
    rawRow.lifecycle === 'stale' ||
    rawRow.lifecycle === 'failed'
      ? { lifecycle: rawRow.lifecycle }
      : {}),
    ...(rawRow.projection !== undefined
      ? { projection: rawRow.projection as CatalogProjection }
      : {}),
    ...(rawRow.publication !== undefined
      ? { publication: rawRow.publication as AssetPublicationEnvelope }
      : {}),
  };
}

/** Parse the shared pack-index/catalog wire shape without loading payloads. */
export function parseCatalog(
  raw: unknown,
  resolveUrl: (packageUrl: string) => string = (packageUrl) => packageUrl,
  expectedRevision?: ResourceRevision,
  expectedScope?: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>,
): Result<Map<string, CatalogRecord>, AssetError> {
  if (expectedScope !== undefined) {
    const scopeError = scopedSnapshotError(raw, expectedScope);
    if (scopeError !== undefined) return err(scopeError);
  }
  const decoded = decodeCatalogWire(raw);
  if (!decoded.ok) return decoded;
  const rows: readonly unknown[] = decoded.value;

  const catalog = new Map<string, CatalogRecord>();
  for (const item of rows) {
    const identity = catalogRowIdentity(item);
    if (!identity.ok) return identity;
    const { rawRow, guid: rawGuid } = identity.value;
    const guid = rawGuid.toLowerCase();
    if (catalog.has(guid)) return err(parseError(`catalog GUID ${rawGuid} to be unique`));
    const fieldError = catalogRowFieldError(rawRow, rawGuid);
    if (fieldError !== undefined) return err(fieldError);
    const resolvedUrl = resolveRowUrl(identity.value, resolveUrl);
    if (!resolvedUrl.ok) return resolvedUrl;
    catalog.set(guid, {
      packageUrl: resolvedUrl.value,
      kind: identity.value.kind,
      ...catalogNavigationFields(rawRow),
      ...catalogProvenanceFields(rawRow),
      ...catalogLifecycleFields(rawRow),
    });
  }
  const revisionError = checkExpectedRevision([...catalog.values()], expectedRevision);
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
      readonly entries: Map<string, CatalogRecord>;
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
