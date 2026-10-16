import type {
  CatalogDelta,
  CatalogDiagnostic,
  CatalogRevisionWindow,
  ImportedOutputDeclaration,
  PackIndexEntry,
} from '@forgeax/engine-types';
import { catalogEntryDigest } from '@forgeax/engine-types';
import { diffTopology } from './topology.js';

function rowsByGuid(rows: readonly PackIndexEntry[]): Map<string, PackIndexEntry> {
  return new Map(rows.map((row) => [row.guid.toLowerCase(), row]));
}

function sameRow(left: PackIndexEntry, right: PackIndexEntry): boolean {
  return catalogEntryDigest(left) === catalogEntryDigest(right);
}

function topologyGroups(rows: readonly PackIndexEntry[]): Map<string, ImportedOutputDeclaration[]> {
  const groups = new Map<string, ImportedOutputDeclaration[]>();
  for (const row of rows) {
    // Legacy catalog rows have neither producer topology field. Do not turn
    // their incidental catalog position into a false topology claim.
    if (row.packageId === undefined) continue;
    if (row.sourceKey === undefined && row.sourceIndex === undefined) continue;
    const groupId = row.packageId;
    const group = groups.get(groupId) ?? [];
    group.push({
      guid: row.guid,
      ...(row.sourceKey !== undefined ? { sourceKey: row.sourceKey } : {}),
      sourceIndex: row.sourceIndex ?? 0,
      kind: row.kind,
      ...(row.name !== undefined ? { name: row.name } : {}),
    });
    groups.set(groupId, group);
  }
  return groups;
}

function revisionDiagnostic(
  code: string,
  expected: string,
  actual: string,
  hint: string,
  rootId?: string,
): CatalogDiagnostic {
  return {
    code,
    severity: 'blocking',
    authority: 'catalog',
    expected,
    actual,
    hint,
    ...(rootId === undefined ? {} : { subject: { type: 'package' as const, id: rootId } }),
  };
}

function checkRevisionContinuity(
  window: CatalogRevisionWindow,
  hasChanges: boolean,
): CatalogDiagnostic | undefined {
  const baselineByRoot = new Map(window.baseline.map((point) => [point.rootId, point]));
  const currentRoots = new Set(window.current.map((point) => point.rootId));

  for (const point of window.current) {
    const baseline = baselineByRoot.get(point.rootId);
    if (baseline === undefined) {
      return revisionDiagnostic(
        'catalog-revision-conflict',
        'every current root must have a verified baseline',
        point.rootId,
        'restore the latest verified snapshot for this root before applying the delta',
        point.rootId,
      );
    }
    if (point.revision < baseline.revision) {
      return revisionDiagnostic(
        'catalog-revision-stale',
        'current revision must not be older than baseline',
        `${baseline.revision} -> ${point.revision}`,
        'discard the stale update and request a fresh catalog snapshot',
        point.rootId,
      );
    }
    if (point.revision === baseline.revision && hasChanges) {
      return revisionDiagnostic(
        'catalog-revision-conflict',
        'a changed delta must advance the root revision',
        `${baseline.revision} -> ${point.revision}`,
        'keep the verified baseline and serialize concurrent updates before retrying',
        point.rootId,
      );
    }
    if (point.revision > baseline.revision + 1) {
      return revisionDiagnostic(
        'catalog-revision-conflict',
        'the next revision must be exactly baseline + 1',
        `${baseline.revision} -> ${point.revision}`,
        'request the missing revisions or rebuild from the latest verified snapshot',
        point.rootId,
      );
    }
  }

  for (const point of window.baseline) {
    if (!currentRoots.has(point.rootId)) {
      return revisionDiagnostic(
        'catalog-revision-conflict',
        'every baseline root must be present in the current revision set',
        point.rootId,
        'do not apply a partial root set over the verified baseline',
        point.rootId,
      );
    }
  }

  return undefined;
}

/**
 * Derives one neutral delta from consecutive complete catalog projections.
 *
 * The returned fields are canonical POD fields: topology, revision continuity,
 * authority, and diagnostics remain structured so AI consumers do not parse
 * producer or transport messages. Degraded results intentionally contain no
 * added, changed, or removed identity rows.
 */
export function calculateCatalogDelta(
  previous: readonly PackIndexEntry[],
  next: readonly PackIndexEntry[],
  revision?: CatalogRevisionWindow,
): CatalogDelta | undefined {
  const before = rowsByGuid(previous);
  const after = rowsByGuid(next);
  const added: PackIndexEntry[] = [];
  const changed: PackIndexEntry[] = [];
  const removed: string[] = [];

  for (const [guid, row] of after) {
    const prior = before.get(guid);
    if (prior === undefined) added.push(row);
    else if (!sameRow(prior, row)) changed.push(row);
  }
  for (const guid of before.keys()) {
    if (!after.has(guid)) removed.push(guid);
  }

  const previousGroups = topologyGroups(previous);
  const nextGroups = topologyGroups(next);
  const topology = [];
  const groupIds = new Set([...previousGroups.keys(), ...nextGroups.keys()]);
  for (const groupId of groupIds) {
    const diff = diffTopology(previousGroups.get(groupId) ?? [], nextGroups.get(groupId) ?? []);
    if (
      diff.added.length > 0 ||
      diff.removed.length > 0 ||
      diff.changedKind.length > 0 ||
      diff.ambiguous.length > 0
    ) {
      topology.push(diff);
    }
  }

  const hasChanges =
    added.length > 0 || changed.length > 0 || removed.length > 0 || topology.length > 0;
  if (!hasChanges) return undefined;

  const delta = { added, changed, removed, ...(topology.length > 0 ? { topology } : {}) };
  if (revision === undefined) return delta;

  const diagnostic = checkRevisionContinuity(revision, hasChanges);
  if (diagnostic !== undefined) {
    return {
      added: [],
      changed: [],
      removed: [],
      authority: 'degraded',
      diagnostics: [diagnostic],
      revisions: revision,
    };
  }

  return {
    ...delta,
    authority: 'authoritative',
    diagnostics: [],
    revisions: revision,
  };
}
