import type {
  AssetRelation,
  CatalogDiagnostic,
  CatalogLifecycle,
  CatalogSubject,
  CookExecution,
  PackIndexEntry,
  ProviderProvenance,
  ResourceRevision,
  SourceOverrideDescriptor,
} from '@forgeax/engine-types';
import { authoringCapabilityForAssetKind, catalogOperationsFor } from '@forgeax/engine-types';

export function catalogProjectionFor(
  subject: CatalogSubject,
  execution: CookExecution,
  lifecycle: CatalogLifecycle,
) {
  return {
    subject,
    execution,
    lifecycle,
    operations: catalogOperationsFor({ subject, execution, lifecycle }),
  } as const;
}

export function currentProjectionFor(subject: CatalogSubject, execution: CookExecution) {
  return catalogRowProjectionFor(subject, execution, 'current');
}

function catalogRowProjectionFor(
  subject: CatalogSubject,
  execution: CookExecution,
  lifecycle: CatalogLifecycle,
) {
  const projection = catalogProjectionFor(subject, execution, lifecycle);
  return { subject, execution, lifecycle, projection } as const;
}

export interface CatalogProducerMeta {
  readonly schemaVersion: string | number;
  readonly packageId?: string;
  readonly provenance?: ProviderProvenance;
  readonly revision?: ResourceRevision;
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly provider?: string;
  readonly importer?: string;
  readonly sourceOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly sourceOverrideDescriptors?: readonly SourceOverrideDescriptor[];
}

export interface CatalogOutputDeclaration
  extends Pick<
    PackIndexEntry,
    'guid' | 'kind' | 'sourceKey' | 'sourceIndex' | 'relations' | 'authoring' | 'refs' | 'name'
  > {}

function referenceRelations(
  guid: string,
  refs: readonly string[] | undefined,
  provenance: ProviderProvenance,
): readonly AssetRelation[] | undefined {
  if (refs === undefined || refs.length === 0) return undefined;
  return refs.map((ref) => ({
    from: { type: 'asset', id: guid } as const,
    to: { type: 'asset', id: ref } as const,
    type: 'references' as const,
    policy: { strength: 'required' as const },
    provenance,
  }));
}

type ProducerSourceOverrides = NonNullable<CatalogProducerMeta['sourceOverrides']>;

/**
 * Overrides are addressed by source key, and an importer reads only its own
 * output's entry. Each row carries just that entry, the same way
 * `sourceOverrideDescriptors` are filtered: copying the producer's whole map
 * onto every row makes Catalog size grow with outputs × overrides, which for
 * a source with many sub-assets dominates the index. The rows of one producer
 * still hold the complete map between them.
 */
export function sourceOverridesForOutput(
  overrides: ProducerSourceOverrides | undefined,
  sourceKey: string | undefined,
): Pick<PackIndexEntry, 'sourceOverrides'> {
  if (overrides === undefined || sourceKey === undefined) return {};
  if (!Object.hasOwn(overrides, sourceKey)) return {};
  const entry = overrides[sourceKey];
  return entry === undefined ? {} : { sourceOverrides: { [sourceKey]: entry } };
}

function producerFields(
  producer: CatalogProducerMeta,
  output: CatalogOutputDeclaration,
): Pick<
  PackIndexEntry,
  | 'packageId'
  | 'provenance'
  | 'revision'
  | 'sourceKey'
  | 'sourceIndex'
  | 'sourceOverrides'
  | 'sourceOverrideDescriptors'
  | 'relations'
  | 'diagnostics'
  | 'subject'
  | 'execution'
  | 'lifecycle'
  | 'projection'
  | 'authoring'
> {
  const provenance =
    producer.provenance ??
    ({
      provider: producer.provider ?? producer.importer ?? 'engine',
      version: String(producer.schemaVersion),
    } satisfies ProviderProvenance);
  const relations = output.relations ?? referenceRelations(output.guid, output.refs, provenance);
  const inferred = authoringCapabilityForAssetKind(output.kind);
  return {
    provenance,
    ...(producer.packageId === undefined ? {} : { packageId: producer.packageId }),
    ...(producer.revision === undefined ? {} : { revision: producer.revision }),
    ...(output.sourceKey === undefined ? {} : { sourceKey: output.sourceKey }),
    ...(output.sourceIndex === undefined ? {} : { sourceIndex: output.sourceIndex }),
    ...sourceOverridesForOutput(producer.sourceOverrides, output.sourceKey),
    ...(producer.sourceOverrideDescriptors === undefined || output.sourceKey === undefined
      ? {}
      : {
          sourceOverrideDescriptors: producer.sourceOverrideDescriptors.filter(
            (descriptor) => descriptor.sourceKey === output.sourceKey,
          ),
        }),
    ...(relations === undefined ? {} : { relations }),
    ...(producer.diagnostics === undefined ? {} : { diagnostics: producer.diagnostics }),
    ...(output.authoring === undefined && inferred.ui === undefined
      ? {}
      : { authoring: output.authoring ?? inferred }),
    ...catalogRowProjectionFor('imported-output', 'cooked', 'missing'),
  };
}

/** Project producer declarations without interpreting a provider's kind vocabulary. */
export function projectExternalCatalogEntries(
  producer: CatalogProducerMeta,
  sourcePath: string,
  packageUrl: string,
  outputs: readonly CatalogOutputDeclaration[],
  nameFor?: (output: CatalogOutputDeclaration, index: number) => string | undefined,
): PackIndexEntry[] {
  return outputs.map((output, index) => {
    const name = nameFor?.(output, index) ?? output.name;
    return {
      guid: output.guid,
      packageUrl,
      kind: output.kind,
      sourcePath,
      ...producerFields(producer, output),
      ...(name === undefined ? {} : { name }),
    };
  });
}

/** A self-contained Pack row before package placement and runtime projection axes. */
export type PackageCatalogInput = Omit<
  PackIndexEntry,
  'packageUrl' | 'subject' | 'lifecycle' | 'projection' | 'publication'
>;

/** Project self-contained Pack rows into the same Catalog contract as producer output. */
export function projectPackageCatalog(
  entries: readonly PackageCatalogInput[],
  packageUrl: string,
): PackIndexEntry[] {
  return entries.map((entry) => {
    const execution = entry.execution ?? 'direct';
    const lifecycle = execution === 'cooked' ? 'missing' : 'current';
    const inferred = authoringCapabilityForAssetKind(entry.kind);
    const provenance =
      entry.provenance ?? ({ provider: 'pack', version: 'unknown' } satisfies ProviderProvenance);
    const relations = entry.relations ?? referenceRelations(entry.guid, entry.refs, provenance);
    return {
      guid: entry.guid,
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      packageUrl,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.refs === undefined ? {} : { refs: entry.refs }),
      ...(entry.packageId === undefined ? {} : { packageId: entry.packageId }),
      ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
      ...(entry.revision === undefined ? {} : { revision: entry.revision }),
      ...(entry.sourceKey === undefined ? {} : { sourceKey: entry.sourceKey }),
      ...(entry.sourceIndex === undefined ? {} : { sourceIndex: entry.sourceIndex }),
      ...(entry.sourceOverrides === undefined ? {} : { sourceOverrides: entry.sourceOverrides }),
      ...(entry.sourceOverrideDescriptors === undefined
        ? {}
        : { sourceOverrideDescriptors: entry.sourceOverrideDescriptors }),
      ...(relations === undefined ? {} : { relations }),
      ...(entry.diagnostics === undefined ? {} : { diagnostics: entry.diagnostics }),
      ...(entry.cookReceiptUrl === undefined ? {} : { cookReceiptUrl: entry.cookReceiptUrl }),
      ...(entry.authoring === undefined && inferred.ui === undefined
        ? {}
        : { authoring: entry.authoring ?? inferred }),
      ...catalogRowProjectionFor('internal-asset', execution, lifecycle),
    };
  });
}
