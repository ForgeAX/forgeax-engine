import {
  AssetError,
  type AssetPublicationEnvelope,
  type CatalogEntry,
  err,
  ok,
  type Result,
  RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
  type RuntimeCatalogSnapshot,
} from '@forgeax/engine-types';

export interface CompactCatalogWire {
  readonly schemaVersion: 'pack-index-publications/1';
  readonly entries: readonly (Omit<CatalogEntry, 'publication'> & {
    readonly publicationIndex?: number;
  })[];
  readonly publications: readonly AssetPublicationEnvelope[];
}

/** Scoped identity stays outside the existing publication-table transport. */
export interface RuntimeCatalogWire extends Omit<RuntimeCatalogSnapshot, 'entries'> {
  readonly entries: CompactCatalogWire | readonly CatalogEntry[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function publicationField(value: unknown): string | undefined {
  if (!record(value)) return '';
  if (value.schemaVersion !== 'asset-publication/1') return '.schemaVersion';
  for (const key of ['sourcePath', 'sourceRevision', 'digest', 'outputSetDigest']) {
    if (typeof value[key] !== 'string') return `.${key}`;
  }
  if (typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation))
    return '.generation';
  if (!Array.isArray(value.outputs)) return '.outputs';
  for (let index = 0; index < value.outputs.length; index++) {
    const output = value.outputs[index];
    if (!record(output)) return `.outputs[${index}]`;
    for (const key of ['guid', 'sourceKey', 'kind', 'digest']) {
      if (typeof output[key] !== 'string') return `.outputs[${index}].${key}`;
    }
    if (!strings(output.refs)) return `.outputs[${index}].refs`;
  }
  if (!Array.isArray(value.externalEvidence)) return '.externalEvidence';
  const receipt = value.receipt;
  if (!record(receipt)) return '.receipt';
  if (receipt.schemaVersion !== 'asset-publication-receipt/1') return '.receipt.schemaVersion';
  for (const key of [
    'sourcePath',
    'sourceRevision',
    'inputFingerprint',
    'outputDigest',
    'outputSetDigest',
  ]) {
    if (typeof receipt[key] !== 'string') return `.receipt.${key}`;
  }
  if (!Array.isArray(receipt.externalEvidence)) return '.receipt.externalEvidence';
  return undefined;
}

/** Transport only: keep every producer field and complete publication tuple.
 * Invalid typed producer input is a programmer error and throws TypeError.
 */
export function encodeCatalogWire(
  catalog: RuntimeCatalogSnapshot | readonly CatalogEntry[],
): RuntimeCatalogWire | CompactCatalogWire | readonly CatalogEntry[] {
  return 'schemaVersion' in catalog
    ? { ...catalog, entries: encodeCatalogRows(catalog.entries) }
    : encodeCatalogRows(catalog);
}

function encodeCatalogRows(
  entries: readonly CatalogEntry[],
): CompactCatalogWire | readonly CatalogEntry[] {
  const publications: AssetPublicationEnvelope[] = [];
  const indices = new Map<string, number>();
  const serializedPublications = new Map<AssetPublicationEnvelope, string>();
  let repeated = false;
  const compact: CompactCatalogWire = {
    schemaVersion: 'pack-index-publications/1',
    entries: entries.map((entry) => {
      if (Object.hasOwn(entry, 'publicationIndex')) {
        throw new TypeError('catalog row already contains a wire publicationIndex');
      }
      const { publication: envelope, ...row } = entry;
      if (envelope === undefined) return row;
      let serialized = serializedPublications.get(envelope);
      if (serialized === undefined) {
        if (publicationField(envelope) !== undefined)
          throw new TypeError('invalid catalog publication table entry');
        serialized = JSON.stringify(envelope);
        serializedPublications.set(envelope, serialized);
      }
      let index = indices.get(serialized);
      if (index === undefined) {
        index = publications.length;
        indices.set(serialized, index);
        publications.push(envelope);
      } else {
        repeated = true;
      }
      return { ...row, publicationIndex: index };
    }),
    publications,
  };
  return repeated ? compact : entries;
}

function wireFailure(field: string, index?: number): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-parse-failed',
      expected:
        'a lossless pack-index-publications/1 document with complete referenced publications',
      hint: 'rebuild the catalog with its complete publication table and valid row references',
      detail: {
        field,
        value: index === undefined ? null : { index },
        reason: 'invalid compact catalog wire field',
      },
    }),
  );
}

/** Restore existing readonly rows before ordinary Catalog validation. */
export function decodeCatalogWire(raw: unknown): Result<readonly CatalogEntry[], AssetError> {
  if (record(raw) && raw.schemaVersion === RUNTIME_CATALOG_SNAPSHOT_SCHEMA) {
    if (typeof raw.scopeId !== 'string') return wireFailure('scopeId');
    if (typeof raw.generation !== 'number' || !Number.isSafeInteger(raw.generation))
      return wireFailure('generation');
    if (raw.authority !== 'authoritative') return wireFailure('authority');
    // Unwrap exactly one scope; nested scoped containers are not row transport.
    raw = raw.entries;
  }
  if (Array.isArray(raw)) return ok(raw as readonly CatalogEntry[]);
  if (!record(raw)) return wireFailure('catalog');
  if (raw.schemaVersion !== 'pack-index-publications/1') return wireFailure('schemaVersion');
  const unknownField = Object.keys(raw).find(
    (key) => !['schemaVersion', 'entries', 'publications'].includes(key),
  );
  if (unknownField !== undefined) return wireFailure(unknownField);
  if (!Array.isArray(raw.entries)) return wireFailure('entries');
  if (!Array.isArray(raw.publications)) return wireFailure('publications');
  for (let index = 0; index < raw.publications.length; index++) {
    const field = publicationField(raw.publications[index]);
    if (field !== undefined) return wireFailure(`publications[${index}]${field}`, index);
  }
  const publications = raw.publications as AssetPublicationEnvelope[];
  const referenced = new Set<number>();
  const entries: CatalogEntry[] = [];
  for (let index = 0; index < raw.entries.length; index++) {
    const entry: unknown = raw.entries[index];
    if (!record(entry)) return wireFailure(`entries[${index}]`, index);
    if (Object.hasOwn(entry, 'publication'))
      return wireFailure(`entries[${index}].publication`, index);
    const { publicationIndex, ...row } = entry;
    if (!Object.hasOwn(entry, 'publicationIndex')) {
      entries.push(row as unknown as CatalogEntry);
      continue;
    }
    if (
      typeof publicationIndex !== 'number' ||
      !Number.isSafeInteger(publicationIndex) ||
      publicationIndex < 0 ||
      publicationIndex >= publications.length
    ) {
      return wireFailure(`entries[${index}].publicationIndex`, index);
    }
    referenced.add(publicationIndex);
    // Producer rows already share a readonly envelope. Restore that same model;
    // neither the input document nor any of its publication fields is mutated.
    entries.push({
      ...row,
      publication: publications[publicationIndex],
    } as unknown as CatalogEntry);
  }
  for (let index = 0; index < publications.length; index++) {
    if (!referenced.has(index)) return wireFailure(`publications[${index}]`, index);
  }
  return ok(entries);
}
