import type { CatalogEntry } from '@forgeax/engine-types';
import { type AssetLoadError, err, ok, type Result } from '@forgeax/engine-types';

export interface RuntimeCatalogRow extends CatalogEntry {
  readonly publication: NonNullable<CatalogEntry['publication']>;
}

function invalidRow(guid: string, reason: string): Result<never, AssetLoadError> {
  return err({
    code: 'asset-package-invalid',
    expected: 'one complete current runtime Catalog row',
    hint: 'rebuild the producer Catalog and publish one Pack v2 tuple',
    detail: { guid, reason },
  });
}

function validateCatalogRow(row: CatalogEntry): Result<CatalogEntry, AssetLoadError> {
  if (row === null || typeof row !== 'object') return invalidRow('', 'row');
  const candidate = row as Partial<CatalogEntry>;
  const guid = typeof candidate.guid === 'string' ? candidate.guid : '';
  if (guid.trim().length === 0) return invalidRow(guid, 'guid');
  if (typeof candidate.kind !== 'string' || candidate.kind.trim().length === 0)
    return invalidRow(guid, 'kind');
  if (typeof candidate.packageUrl !== 'string' || candidate.packageUrl.trim().length === 0)
    return invalidRow(guid, 'packageUrl');
  if (typeof candidate.sourcePath !== 'string' || candidate.sourcePath.trim().length === 0)
    return invalidRow(guid, 'sourcePath');
  return ok(Object.freeze({ ...candidate, guid }) as CatalogEntry);
}

export function validateRuntimeRow(row: CatalogEntry): Result<RuntimeCatalogRow, AssetLoadError> {
  const navigation = validateCatalogRow(row);
  if (!navigation.ok) return navigation;
  const candidate = navigation.value;
  const guid = candidate.guid;
  if (!Number.isSafeInteger(candidate.publication?.generation))
    return invalidRow(guid, 'publication generation');
  if (candidate.publication === undefined) return invalidRow(guid, 'publication');
  const publication = candidate.publication;
  if (
    publication.schemaVersion !== 'asset-publication/1' ||
    typeof publication.sourcePath !== 'string' ||
    publication.sourcePath.trim().length === 0 ||
    typeof publication.sourceRevision !== 'string' ||
    publication.sourceRevision.trim().length === 0 ||
    publication.generation < 0 ||
    typeof publication.digest !== 'string' ||
    publication.digest.trim().length === 0 ||
    typeof publication.outputSetDigest !== 'string' ||
    publication.outputSetDigest.trim().length === 0 ||
    !Array.isArray(publication.outputs) ||
    publication.receipt === null ||
    typeof publication.receipt !== 'object' ||
    !Array.isArray(publication.externalEvidence)
  ) {
    return invalidRow(guid, 'publication tuple');
  }
  return ok(Object.freeze({ ...candidate, guid, publication }) as RuntimeCatalogRow);
}
