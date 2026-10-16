import type { AssetPublicationTuple } from './asset.js';
import type {
  AssetAuthoringCapability,
  AssetPublicationEnvelope,
  AssetRelation,
  CatalogDiagnostic,
  CatalogLifecycle,
  CatalogProjection,
  CatalogSubject,
  CookExecution,
  ProviderProvenance,
  ResourceRevision,
  SourceOverrideDescriptor,
  SourceOverrideMap,
  TopologyDiff,
} from './asset-producer';
import { err, ok, type Result } from './result';

export type {
  AssetPublicationEnvelope,
  AssetPublicationEvidenceUsage,
  AssetPublicationExternalEvidence,
  AssetPublicationFailure,
  AssetPublicationFailureStage,
  AssetPublicationLocator,
  AssetPublicationOutput,
  AssetPublicationReceipt,
  AssetPublicationRecovery,
  CatalogLifecycle,
  CatalogProjection,
  CatalogSubject,
  CookExecution,
} from './asset-producer';

/**
 * Strict contract row for the Catalog projection.
 *
 * This is evidence for an AI consumer, not authoring authority: a Catalog row
 * projects producer facts and runtime navigation while preserving lifecycle,
 * execution, and sourceKey distinctions.
 */
export interface CatalogEntryV2 extends AssetPublicationTuple {
  readonly guid: string;
  readonly packageUrl: string;
  readonly kind: string;
  readonly sourcePath: string;
  readonly subject: CatalogSubject;
  readonly execution: CookExecution;
  readonly lifecycle: CatalogLifecycle;
  readonly projection: CatalogProjection;
}
/** One producer revision point in a catalog continuity window. */
export interface CatalogRevisionPoint {
  readonly rootId: string;
  readonly revision: number;
}

/** Baseline/current revision sets used to reject stale or partial updates. */
export interface CatalogRevisionWindow {
  readonly baseline: readonly CatalogRevisionPoint[];
  readonly current: readonly CatalogRevisionPoint[];
}

/** One stable row from a development or build catalog snapshot. */
export interface CatalogEntry {
  readonly guid: string;
  /** GUID-to-pack navigation only; artifact paths live inside Pack v2. */
  readonly packageUrl: string;
  readonly kind: string;
  /** Producer-owned placement/binding facts; absent only on legacy rows. */
  readonly authoring?: AssetAuthoringCapability;
  /** Source declaration navigation for diagnostics, not runtime content. */
  readonly sourcePath: string;
  /** Stable package identity; path is a locator, never the package identity. */
  readonly packageId?: string;
  /** Producer-owned importer/provider identity and version. */
  readonly provenance?: ProviderProvenance;
  /** Producer-owned resource/package revision used for conflict checks. */
  readonly revision?: ResourceRevision;
  /** Stable producer key for imported-output topology matching; never infer it from sourceIndex. */
  readonly sourceKey?: string;
  /** Producer-declared output position; never used as identity when sourceKey exists. */
  readonly sourceIndex?: number;
  /** Producer-owned author facts carried through the catalog without interpretation. */
  readonly sourceOverrides?: SourceOverrideMap;
  readonly sourceOverrideDescriptors?: readonly SourceOverrideDescriptor[];
  /** Typed graph edges emitted by the producer. */
  readonly relations?: readonly AssetRelation[];
  /** Structured producer diagnostics; consumers must not parse messages. */
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly name?: string;
  /** Optional navigation to the producer-owned cook receipt. */
  readonly cookReceiptUrl?: string;
  readonly refs?: readonly string[];
  /** Explicit producer-owned runtime projection axes. */
  readonly subject?: CatalogSubject;
  readonly execution?: CookExecution;
  readonly lifecycle?: CatalogLifecycle;
  readonly projection?: CatalogProjection;
  /** Complete Engine publication tuple, when this row came from a source package. */
  readonly publication?: AssetPublicationEnvelope;
}

/**
 * A folded, neutral set of catalog-row changes keyed by stable GUID.
 *
 * `authority` and `diagnostics` tell AI-readable consumers whether the delta
 * is safe to apply; a degraded delta carries no identity-bearing changes.
 */
export interface CatalogDelta {
  /** Runtime realm identity for dev publications; absent for immutable legacy builds. */
  readonly scopeId?: string;
  readonly generation?: number;
  readonly added: readonly CatalogEntry[];
  readonly changed: readonly CatalogEntry[];
  readonly removed: readonly CatalogEntry['guid'][];
  /** Optional topology evidence for imported-output changes in this delta. */
  readonly topology?: readonly TopologyDiff[];
  /** Present when a watch revision was supplied for continuity validation. */
  readonly authority?: 'authoritative' | 'degraded';
  /** Machine-readable continuity or topology diagnostics. */
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly revisions?: CatalogRevisionWindow;
}

export interface CatalogDeltaValidationError {
  readonly code: 'catalog-delta-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly field: string };
}

function catalogInvalid(field: string): Result<never, CatalogDeltaValidationError> {
  return err({
    code: 'catalog-delta-invalid',
    expected: 'a CatalogDelta with complete row identity and string removals',
    hint: 'discard the delta and enumerate a verified catalog snapshot',
    detail: { field },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isSubjectRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.type === 'asset' || value.type === 'package' || value.type === 'resource') &&
    isNonEmptyString(value.id)
  );
}

function isRevision(value: unknown): value is ResourceRevision {
  if (!isRecord(value)) return false;
  const observedAt = value.observedAt;
  return (
    isNonEmptyString(value.digest) &&
    typeof observedAt === 'number' &&
    Number.isSafeInteger(observedAt) &&
    observedAt >= 0 &&
    isNonEmptyString(value.rootId)
  );
}

function isDiagnostic(value: unknown): value is CatalogDiagnostic {
  return (
    isRecord(value) &&
    isNonEmptyString(value.code) &&
    (value.severity === 'info' || value.severity === 'warning' || value.severity === 'blocking') &&
    (value.message === undefined || typeof value.message === 'string') &&
    (value.subject === undefined || isSubjectRef(value.subject)) &&
    (value.expected === undefined || typeof value.expected === 'string') &&
    (value.actual === undefined || typeof value.actual === 'string') &&
    (value.hint === undefined || typeof value.hint === 'string') &&
    (value.authority === undefined ||
      value.authority === 'producer' ||
      value.authority === 'pack' ||
      value.authority === 'catalog') &&
    (value.evidence === undefined ||
      (Array.isArray(value.evidence) && value.evidence.every(isSubjectRef))) &&
    (value.recoveryIntents === undefined || isStringArray(value.recoveryIntents))
  );
}

function isRevisionWindow(value: unknown): value is CatalogRevisionWindow {
  if (!isRecord(value) || !Array.isArray(value.baseline) || !Array.isArray(value.current)) {
    return false;
  }
  const isPoint = (point: unknown): boolean =>
    isRecord(point) &&
    isNonEmptyString(point.rootId) &&
    typeof point.revision === 'number' &&
    Number.isSafeInteger(point.revision) &&
    point.revision >= 0;
  return value.baseline.every(isPoint) && value.current.every(isPoint);
}

function isTopologyDiff(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ['preserved', 'added', 'removed', 'changedKind', 'ambiguous'].every((field) =>
    Array.isArray(value[field]),
  );
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.guid) ||
    !isNonEmptyString(value.packageUrl) ||
    !isNonEmptyString(value.kind) ||
    !isNonEmptyString(value.sourcePath)
  ) {
    return false;
  }
  if (value.authoring !== undefined && !isRecord(value.authoring)) return false;
  if (value.packageId !== undefined && !isNonEmptyString(value.packageId)) return false;
  if (value.provenance !== undefined) {
    if (!isRecord(value.provenance)) return false;
    if (
      !isNonEmptyString(value.provenance.provider) ||
      !isNonEmptyString(value.provenance.version)
    ) {
      return false;
    }
    if (value.provenance.source !== undefined && !isNonEmptyString(value.provenance.source)) {
      return false;
    }
  }
  if (value.revision !== undefined && !isRevision(value.revision)) return false;
  if (value.sourceKey !== undefined && !isNonEmptyString(value.sourceKey)) return false;
  const sourceIndex = value.sourceIndex;
  if (
    sourceIndex !== undefined &&
    (typeof sourceIndex !== 'number' || !Number.isSafeInteger(sourceIndex) || sourceIndex < 0)
  )
    return false;
  if (value.sourceOverrides !== undefined && !isRecord(value.sourceOverrides)) return false;
  if (
    value.sourceOverrideDescriptors !== undefined &&
    !Array.isArray(value.sourceOverrideDescriptors)
  ) {
    return false;
  }
  if (value.relations !== undefined && !Array.isArray(value.relations)) return false;
  if (
    value.diagnostics !== undefined &&
    (!Array.isArray(value.diagnostics) || !value.diagnostics.every(isDiagnostic))
  )
    return false;
  if (value.name !== undefined && !isNonEmptyString(value.name)) return false;
  if (value.cookReceiptUrl !== undefined && !isNonEmptyString(value.cookReceiptUrl)) return false;
  if (value.refs !== undefined && !isStringArray(value.refs)) return false;
  if (
    value.subject !== undefined &&
    value.subject !== 'internal-asset' &&
    value.subject !== 'imported-output'
  ) {
    return false;
  }
  if (
    value.execution !== undefined &&
    value.execution !== 'direct' &&
    value.execution !== 'cooked'
  ) {
    return false;
  }
  if (
    value.lifecycle !== undefined &&
    !['missing', 'cooking', 'current', 'stale', 'failed'].includes(value.lifecycle as string)
  ) {
    return false;
  }
  if (value.projection !== undefined && !isRecord(value.projection)) return false;
  return value.publication === undefined || isRecord(value.publication);
}

export function validateCatalogDelta(
  value: unknown,
): Result<CatalogDelta, CatalogDeltaValidationError> {
  if (!isRecord(value)) return catalogInvalid('delta');
  if (!Array.isArray(value.added)) return catalogInvalid('added');
  if (!Array.isArray(value.changed)) return catalogInvalid('changed');
  if (!Array.isArray(value.removed)) return catalogInvalid('removed');
  if (!value.added.every(isCatalogEntry)) return catalogInvalid('added.entry');
  if (!value.changed.every(isCatalogEntry)) return catalogInvalid('changed.entry');
  if (!value.removed.every((guid): guid is string => typeof guid === 'string' && guid.length > 0)) {
    return catalogInvalid('removed.guid');
  }
  const generation = value.generation;
  if (
    (value.scopeId !== undefined && !isNonEmptyString(value.scopeId)) ||
    (generation !== undefined &&
      (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1))
  ) {
    return catalogInvalid('scope');
  }
  if ((value.scopeId === undefined) !== (value.generation === undefined)) {
    return catalogInvalid('scope.generation');
  }
  if (
    value.authority !== undefined &&
    value.authority !== 'authoritative' &&
    value.authority !== 'degraded'
  ) {
    return catalogInvalid('authority');
  }
  if (
    value.diagnostics !== undefined &&
    (!Array.isArray(value.diagnostics) || !value.diagnostics.every(isDiagnostic))
  ) {
    return catalogInvalid('diagnostics');
  }
  if (value.revisions !== undefined && !isRevisionWindow(value.revisions)) {
    return catalogInvalid('revisions');
  }
  if (
    value.topology !== undefined &&
    (!Array.isArray(value.topology) || !value.topology.every(isTopologyDiff))
  ) {
    return catalogInvalid('topology');
  }
  const identityKeys = [...value.added, ...value.changed].map((entry) => entry.guid.toLowerCase());
  if (new Set(identityKeys).size !== identityKeys.length) return catalogInvalid('duplicate.guid');
  const removedKeys = value.removed.map((guid) => guid.toLowerCase());
  if (new Set(removedKeys).size !== removedKeys.length) return catalogInvalid('duplicate.removed');
  if (value.authority === 'degraded' && identityKeys.length > 0) {
    return catalogInvalid('degraded.identity');
  }
  return ok(value as unknown as CatalogDelta);
}

function canonicalCatalogValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCatalogValue).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalCatalogValue(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digestPart(value: string, seed: bigint): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

const CATALOG_DIGEST_SEEDS = [
  0xcbf29ce484222325n,
  0x84222325cbf29ce4n,
  0x9e3779b185ebca87n,
  0x517cc1b727220a95n,
];

function catalogDigest(value: unknown): string {
  const canonical = canonicalCatalogValue(value);
  return `sha256:${CATALOG_DIGEST_SEEDS.map((seed) => digestPart(canonical, seed)).join('')}`;
}

/** Canonical semantic identity for one Catalog row, independent of object key order. */
export function catalogEntryDigest(entry: CatalogEntry): string {
  return catalogDigest({ ...entry, guid: entry.guid.toLowerCase() });
}

export function catalogDeltaDigest(delta: CatalogDelta): string {
  return catalogDigest({
    ...delta,
    added: [...delta.added].sort((left, right) => left.guid.localeCompare(right.guid)),
    changed: [...delta.changed].sort((left, right) => left.guid.localeCompare(right.guid)),
    removed: [...delta.removed].sort(),
  });
}

export type PackIndexEntry = CatalogEntry;
