import { isDeepStrictEqual } from 'node:util';
import type {
  AssetPublicationEnvelope,
  CatalogDelta,
  CatalogRevisionWindow,
  ImportedOutputDeclaration,
  PackIndexEntry,
} from '@forgeax/engine-types';
import { checkCatalogRevisionContinuity } from '@forgeax/engine-types';
import { diffTopology } from './topology.js';

function rowsByGuid(rows: readonly PackIndexEntry[]): Map<string, PackIndexEntry> {
  return new Map(rows.map((row) => [row.guid.toLowerCase(), row]));
}

function sameRow(
  left: PackIndexEntry,
  right: PackIndexEntry,
  publications: WeakMap<AssetPublicationEnvelope, WeakMap<AssetPublicationEnvelope, boolean>>,
): boolean {
  const { publication: leftPublication, ...leftFields } = left;
  const { publication: rightPublication, ...rightFields } = right;
  if (
    !isDeepStrictEqual(
      { ...leftFields, guid: left.guid.toLowerCase() },
      { ...rightFields, guid: right.guid.toLowerCase() },
    )
  )
    return false;
  if (leftPublication === rightPublication) return true;
  if (!leftPublication || !rightPublication) return false;
  let compared = publications.get(leftPublication);
  if (!compared) {
    compared = new WeakMap();
    publications.set(leftPublication, compared);
  }
  let equal = compared.get(rightPublication);
  if (equal === undefined) {
    // Compare complete facts, including outputs, without trusting claimed digests
    // or hashing the same shared publication again for every catalog row.
    equal = isDeepStrictEqual(leftPublication, rightPublication);
    compared.set(rightPublication, equal);
  }
  return equal;
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
  const publications = new WeakMap<
    AssetPublicationEnvelope,
    WeakMap<AssetPublicationEnvelope, boolean>
  >();

  for (const [guid, row] of after) {
    const prior = before.get(guid);
    if (prior === undefined) added.push(row);
    else if (!sameRow(prior, row, publications)) changed.push(row);
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

  const diagnostic = checkCatalogRevisionContinuity(revision, hasChanges);
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
