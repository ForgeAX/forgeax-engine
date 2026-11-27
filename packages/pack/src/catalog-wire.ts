import {
  ASSET_ERROR_HINTS,
  AssetError,
  type AssetPublicationEnvelope,
  type CatalogEntry,
  type CatalogProjection,
  err,
  ok,
  type Result,
  RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
  type RuntimeCatalogSnapshot,
} from '@forgeax/engine-types';

export interface CompactCatalogWire {
  readonly schemaVersion: 'pack-index-tables/1';
  readonly entries: readonly (Omit<CatalogEntry, 'publication' | 'projection'> & {
    readonly publicationIndex?: number;
    readonly projectionIndex?: number;
  })[];
  readonly publications: readonly AssetPublicationEnvelope[];
  readonly projections: readonly CatalogProjection[];
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

/** Inline assets can lack a source path. This projection is used for identity lookup. */
export type CatalogNavigationRow = Omit<CatalogEntry, 'sourcePath'> & {
  readonly sourcePath?: string;
};

const navigationFields = {
  name: (value: unknown) => typeof value === 'string',
  sourcePath: (value: unknown) => typeof value === 'string',
  cookReceiptUrl: (value: unknown) => typeof value === 'string',
  packageId: (value: unknown) => typeof value === 'string',
  sourceKey: (value: unknown) => typeof value === 'string',
  sourceIndex: (value: unknown) => typeof value === 'number',
  relations: Array.isArray,
  diagnostics: Array.isArray,
  subject: (value: unknown) => value === 'internal-asset' || value === 'imported-output',
  execution: (value: unknown) => value === 'direct' || value === 'cooked',
  lifecycle: (value: unknown) =>
    value === 'missing' ||
    value === 'cooking' ||
    value === 'current' ||
    value === 'stale' ||
    value === 'failed',
} satisfies Partial<Record<keyof CatalogNavigationRow, (value: unknown) => boolean>>;
const navigationChecks = Object.entries(navigationFields);
const producerFields = [
  'authoring',
  'refs',
  'provenance',
  'revision',
  'sourceOverrides',
  'sourceOverrideDescriptors',
  'projection',
  'publication',
] as const satisfies readonly (keyof CatalogNavigationRow)[];
const locatorFields = [
  ['relative', 'Url'].join(''),
  'metadata',
  'compression',
  'artifacts',
  'assetCodec',
  'contentEncoding',
];

function isRawSourceLocator(packageUrl: string): boolean {
  const path = packageUrl.split(/[?#]/, 1)[0]?.toLowerCase() ?? packageUrl.toLowerCase();
  return (
    /\.(bin|fbx|gltf|glb|hdr|jpg|jpeg|png|wav|mp3|ogg|ttf|otf|woff|woff2|svg)$/.test(path) ||
    path.endsWith('.particle-effect.json')
  );
}

function navigationError(expected: string): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-parse-failed',
      expected,
      hint: ASSET_ERROR_HINTS['asset-parse-failed'],
    }),
  );
}

/** Keep locator metadata in the Pack and preserve legacy inline navigation rows. */
export function readCatalogNavigationRow(raw: unknown): Result<CatalogNavigationRow, AssetError> {
  if (!record(raw)) return navigationError('each catalog row to be an object');
  if (locatorFields.some((key) => key in raw))
    return navigationError('catalog rows to expose navigation fields only');
  const { guid, packageUrl, kind } = raw;
  if (
    typeof guid !== 'string' ||
    !guid ||
    typeof packageUrl !== 'string' ||
    !packageUrl ||
    typeof kind !== 'string' ||
    !kind
  )
    return navigationError('each catalog row to contain guid, packageUrl, and kind strings');
  if (isRawSourceLocator(packageUrl))
    return navigationError(`catalog packageUrl ${packageUrl} to identify a cooked package`);
  if (raw.refs !== undefined && !strings(raw.refs))
    return navigationError(`catalog refs for GUID ${guid} to be a string array`);
  if (raw.sourceOverrides !== undefined && !record(raw.sourceOverrides))
    return navigationError(`catalog sourceOverrides for GUID ${guid} to be an object`);
  if (raw.sourceOverrideDescriptors !== undefined && !Array.isArray(raw.sourceOverrideDescriptors))
    return navigationError(`catalog sourceOverrideDescriptors for GUID ${guid} to be an array`);

  const row = { guid, packageUrl, kind };
  const fields: Record<string, unknown> = row;
  for (const [key, check] of navigationChecks) if (check(raw[key])) fields[key] = raw[key];
  for (const key of producerFields) if (raw[key] !== undefined) fields[key] = raw[key];
  return ok(row);
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

function projectionField(value: unknown): string | undefined {
  if (!record(value)) return '';
  if (value.subject !== 'internal-asset' && value.subject !== 'imported-output') return '.subject';
  if (value.execution !== 'direct' && value.execution !== 'cooked') return '.execution';
  if (
    typeof value.lifecycle !== 'string' ||
    !['missing', 'cooking', 'current', 'stale', 'failed'].includes(value.lifecycle)
  )
    return '.lifecycle';
  if (!record(value.operations)) return '.operations';
  for (const name of [
    'preview',
    'save',
    'rebuild',
    'sourceOverride',
    'instanceOverride',
    'promote',
  ]) {
    const operation = value.operations[name];
    if (!record(operation)) return `.operations.${name}`;
    if (operation.operation !== name) return `.operations.${name}.operation`;
    if (typeof operation.enabled !== 'boolean') return `.operations.${name}.enabled`;
    if (operation.reason !== undefined && typeof operation.reason !== 'string')
      return `.operations.${name}.reason`;
  }
  if (value.lastKnownGood !== undefined) {
    if (!record(value.lastKnownGood)) return '.lastKnownGood';
    if (typeof value.lastKnownGood.packageUrl !== 'string') return '.lastKnownGood.packageUrl';
    if (
      value.lastKnownGood.receiptUrl !== undefined &&
      typeof value.lastKnownGood.receiptUrl !== 'string'
    )
      return '.lastKnownGood.receiptUrl';
  }
  return undefined;
}

function catalogTable<T extends object>(invalidField: (value: unknown) => string | undefined) {
  const values: T[] = [];
  const indices = new Map<string, number>();
  const objectIndices = new Map<T, number>();
  let repeated = false;
  return {
    values,
    get repeated() {
      return repeated;
    },
    reference(value: T): number {
      const cached = objectIndices.get(value);
      if (cached !== undefined) {
        repeated = true;
        return cached;
      }
      if (invalidField(value) !== undefined) throw new TypeError('invalid catalog table entry');
      const serialized = JSON.stringify(value);
      let index = indices.get(serialized);
      if (index === undefined) {
        index = values.length;
        indices.set(serialized, index);
        values.push(value);
      } else {
        repeated = true;
      }
      // Equal cache-restored values retain only their table index, not another
      // complete serialized publication or projection per object.
      objectIndices.set(value, index);
      return index;
    },
  };
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
  const publications = catalogTable<AssetPublicationEnvelope>(publicationField);
  const projections = catalogTable<CatalogProjection>(projectionField);
  const compact: CompactCatalogWire = {
    schemaVersion: 'pack-index-tables/1',
    entries: entries.map((entry) => {
      if (Object.hasOwn(entry, 'publicationIndex') || Object.hasOwn(entry, 'projectionIndex')) {
        throw new TypeError('catalog row already contains a wire table index');
      }
      const { publication, projection, ...row } = entry;
      return {
        ...row,
        ...(publication === undefined
          ? {}
          : { publicationIndex: publications.reference(publication) }),
        ...(projection === undefined ? {} : { projectionIndex: projections.reference(projection) }),
      };
    }),
    publications: publications.values,
    projections: projections.values,
  };
  return publications.repeated || projections.repeated ? compact : entries;
}

function wireFailure(field: string, index?: number): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-parse-failed',
      expected:
        'a lossless pack-index-tables/1 document with complete referenced publications and projections',
      hint: 'rebuild the catalog with its complete tables and valid row references',
      detail: {
        field,
        value: index === undefined ? null : { index },
        reason: 'invalid compact catalog wire field',
      },
    }),
  );
}

function wireTable(
  name: 'publications' | 'projections',
  target: 'publication' | 'projection',
  values: readonly unknown[],
  field: (value: unknown) => string | undefined,
) {
  return { name, target, index: `${target}Index`, values, field, used: new Set<number>() };
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
  if (raw.schemaVersion !== 'pack-index-tables/1') return wireFailure('schemaVersion');
  const unknownField = Object.keys(raw).find(
    (key) => !['schemaVersion', 'entries', 'publications', 'projections'].includes(key),
  );
  if (unknownField !== undefined) return wireFailure(unknownField);
  if (!Array.isArray(raw.entries)) return wireFailure('entries');
  if (!Array.isArray(raw.publications)) return wireFailure('publications');
  if (!Array.isArray(raw.projections)) return wireFailure('projections');
  const publications = wireTable('publications', 'publication', raw.publications, publicationField);
  const projections = wireTable('projections', 'projection', raw.projections, projectionField);
  const tables = [publications, projections];
  for (const table of tables) {
    for (let index = 0; index < table.values.length; index++) {
      const field = table.field(table.values[index]);
      if (field !== undefined) return wireFailure(`${table.name}[${index}]${field}`, index);
    }
  }
  const entries: CatalogEntry[] = [];
  for (let index = 0; index < raw.entries.length; index++) {
    const entry: unknown = raw.entries[index];
    if (!record(entry)) return wireFailure(`entries[${index}]`, index);
    if (Object.hasOwn(entry, 'publication'))
      return wireFailure(`entries[${index}].publication`, index);
    if (Object.hasOwn(entry, 'projection'))
      return wireFailure(`entries[${index}].projection`, index);
    const { publicationIndex: _publication, projectionIndex: _projection, ...row } = entry;
    for (const table of tables) {
      if (!Object.hasOwn(entry, table.index)) continue;
      const reference = entry[table.index];
      if (
        typeof reference !== 'number' ||
        !Number.isSafeInteger(reference) ||
        reference < 0 ||
        reference >= table.values.length
      )
        return wireFailure(`entries[${index}].${table.index}`, index);
      table.used.add(reference);
      row[table.target] = table.values[reference];
    }
    // Producer rows already share a readonly envelope. Restore that same model;
    // neither the input document nor any of its publication fields is mutated.
    entries.push(row as unknown as CatalogEntry);
  }
  for (const table of [projections, publications]) {
    if (table.used.size === table.values.length) continue;
    const index = table.values.findIndex((_, index) => !table.used.has(index));
    return wireFailure(`${table.name}[${index}]`, index);
  }
  return ok(entries);
}
