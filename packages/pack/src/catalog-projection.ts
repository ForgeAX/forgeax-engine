import type {
  AssetAuthoringCapability,
  AssetPublicationEnvelope,
  AssetPublicationTuple,
  AssetRelation,
  CatalogDiagnostic,
  CatalogEntryV2,
  CatalogLifecycle,
  CatalogSubject,
  CookExecution,
  PackIndexEntry,
  ProducerContractDiagnostic,
  ProducerContractResult,
  ProviderProvenance,
  ResourceRevision,
  SourceOverrideDescriptor,
} from '@forgeax/engine-types';
import { authoringCapabilityForAssetKind, catalogOperationsFor } from '@forgeax/engine-types';
import { isRuntimePublicationTuple } from './runtime-projection.js';
import { isScriptablePackAssetKind } from './scriptable-pack.js';

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
  return { ...projection, projection } as const;
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

export interface CatalogOutputDeclaration {
  readonly guid: string;
  readonly kind: string;
  readonly sourceKey?: string;
  readonly sourceIndex?: number;
  readonly relations?: PackIndexEntry['relations'];
  readonly authoring?: AssetAuthoringCapability;
  readonly refs?: readonly string[];
  readonly name?: string;
}

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
    ...(producer.sourceOverrides === undefined
      ? {}
      : { sourceOverrides: producer.sourceOverrides }),
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

/** Return the first declaration that would shadow an engine-owned Pack kind. */
export function findReservedAssetKindConflict(
  outputs: readonly Pick<CatalogOutputDeclaration, 'kind'>[],
): Pick<CatalogOutputDeclaration, 'kind'> | undefined {
  return outputs.find((output) => isScriptablePackAssetKind(output.kind));
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

export interface CookedPackageProjection {
  readonly packageUrl: string;
  readonly revision: ResourceRevision;
  readonly refs: readonly string[];
  readonly cookReceiptUrl?: string;
  readonly publication?: AssetPublicationEnvelope;
}

/** Project one complete cooked package; navigation facts stay in the Pack owner. */
export function projectCookedPackageEntry(
  entry: PackIndexEntry,
  projection: CookedPackageProjection,
): PackIndexEntry {
  return {
    ...entry,
    ...(projection.publication === undefined
      ? {}
      : { sourcePath: projection.publication.sourcePath }),
    packageUrl: projection.packageUrl,
    ...(projection.cookReceiptUrl === undefined
      ? {}
      : { cookReceiptUrl: projection.cookReceiptUrl }),
    revision: projection.revision,
    ...(projection.publication === undefined ? {} : { publication: projection.publication }),
    ...currentProjectionFor('imported-output', 'cooked'),
    refs: projection.refs,
  };
}

export interface RuntimeCatalogRowInput extends AssetPublicationTuple {
  readonly guid: string;
  readonly kind: string;
  readonly packageUrl: string;
  readonly sourcePath?: string;
  readonly subject?: CatalogSubject;
  readonly execution?: CookExecution;
  readonly lifecycle?: CatalogLifecycle;
  readonly publication?: unknown;
}

function runtimeCatalogRowError(
  subjectId: string,
  expected: string,
): ProducerContractResult<never> {
  const diagnostic: ProducerContractDiagnostic = {
    code: 'invalid-producer-fact',
    subject: { type: 'asset', id: subjectId },
    expected,
    hint: 'recook the source and publish one current runtime Catalog row',
    authority: 'producer',
  };
  return { ok: false, error: diagnostic };
}

function projectRuntimeCatalogRowValue(
  input: RuntimeCatalogRowInput,
): ProducerContractResult<CatalogEntryV2> {
  if (
    input.publication !== undefined ||
    input.guid.length === 0 ||
    input.kind.length === 0 ||
    input.packageUrl.length === 0 ||
    !isRuntimePublicationTuple(input)
  ) {
    return runtimeCatalogRowError(
      input.guid,
      'one flat publication tuple and no legacy publication object',
    );
  }

  const subject = input.subject ?? 'imported-output';
  const execution = input.execution ?? 'cooked';
  const lifecycle = input.lifecycle ?? 'current';
  return {
    ok: true,
    value: {
      scopeId: input.scopeId,
      generation: input.generation,
      digest: input.digest,
      outputSetDigest: input.outputSetDigest,
      guid: input.guid,
      kind: input.kind,
      packageUrl: input.packageUrl,
      sourcePath: input.sourcePath ?? input.packageUrl,
      subject,
      execution,
      lifecycle,
      projection: catalogProjectionFor(subject, execution, lifecycle),
    },
  };
}

/** Project one row; an array is accepted only to fail closed on double rows. */
export function projectRuntimeCatalogRow(
  input: RuntimeCatalogRowInput | readonly RuntimeCatalogRowInput[],
): ProducerContractResult<CatalogEntryV2> {
  if (Array.isArray(input)) {
    if (input.length !== 1) {
      return runtimeCatalogRowError(input[0]?.guid ?? 'unknown', 'exactly one runtime row');
    }
    const [row] = input;
    if (row === undefined) return runtimeCatalogRowError('unknown', 'exactly one runtime row');
    return projectRuntimeCatalogRowValue(row);
  }
  return projectRuntimeCatalogRowValue(input as RuntimeCatalogRowInput);
}
