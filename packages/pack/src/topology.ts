import type {
  ExistingOutput,
  ImportedOutputDeclaration,
  KindChange,
  MatchConflict,
  ProposedOutput,
  TopologyDiff,
  TopologyPreserved,
} from '@forgeax/engine-types';

function sourceKey(output: ImportedOutputDeclaration): string | undefined {
  return output.sourceKey === undefined || output.sourceKey.length === 0
    ? undefined
    : output.sourceKey;
}

function bySourceKey<T extends ImportedOutputDeclaration>(
  outputs: readonly T[],
  side: 'previous' | 'next',
  ambiguous: MatchConflict[],
  duplicateKeys: Set<string>,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const output of outputs) {
    const key = sourceKey(output);
    if (key === undefined) continue;
    const prior = result.get(key);
    if (prior !== undefined) {
      duplicateKeys.add(key);
      ambiguous.push({
        reason: 'duplicate-source-key',
        sourceKey: key,
        previous: side === 'previous' ? [prior as ExistingOutput, output as ExistingOutput] : [],
        next: side === 'next' ? [prior as ProposedOutput, output as ProposedOutput] : [],
      });
      continue;
    }
    result.set(key, output);
  }
  return result;
}

function topologyKey(output: ImportedOutputDeclaration): string {
  return `source-index:${output.sourceIndex}`;
}

/**
 * Match importer output declarations without treating sourceIndex or array
 * position as identity. A stable producer sourceKey preserves the prior GUID;
 * multi-output declarations without one are explicitly ambiguous.
 */
export function diffTopology(
  previous: readonly ExistingOutput[],
  next: readonly ProposedOutput[],
): TopologyDiff {
  const preserved: TopologyPreserved[] = [];
  const added: ProposedOutput[] = [];
  const removed: ExistingOutput[] = [];
  const changedKind: KindChange[] = [];
  const ambiguous: MatchConflict[] = [];
  const duplicateKeys = new Set<string>();
  const previousByKey = bySourceKey(previous, 'previous', ambiguous, duplicateKeys);
  const nextByKey = bySourceKey(next, 'next', ambiguous, duplicateKeys);

  for (const [key, oldOutput] of previousByKey) {
    if (duplicateKeys.has(key)) continue;
    const newOutput = nextByKey.get(key);
    if (newOutput === undefined) {
      removed.push(oldOutput);
      continue;
    }
    if (oldOutput.kind === newOutput.kind) {
      preserved.push({ guid: oldOutput.guid, oldKey: key, newKey: key });
    } else {
      const preservesGuid = newOutput.compatiblePreviousKinds?.includes(oldOutput.kind) === true;
      changedKind.push({
        guid: oldOutput.guid,
        oldKind: oldOutput.kind,
        newKind: newOutput.kind,
        sourceKey: key,
        action: preservesGuid ? 'preserve-guid' : 'remove-add',
      });
      if (preservesGuid) {
        preserved.push({ guid: oldOutput.guid, oldKey: key, newKey: key });
      } else {
        removed.push(oldOutput);
        added.push(newOutput);
      }
    }
  }

  for (const [key, newOutput] of nextByKey) {
    if (duplicateKeys.has(key)) continue;
    if (!previousByKey.has(key)) added.push(newOutput);
  }

  // A duplicate producer key is a conflict, not a permission to choose the
  // first map entry. Keep every affected declaration in remove/add evidence
  // while leaving GUID preservation empty until the producer repairs the key.
  for (const output of previous) {
    const key = sourceKey(output);
    if (key !== undefined && duplicateKeys.has(key)) removed.push(output);
  }
  for (const output of next) {
    const key = sourceKey(output);
    if (key !== undefined && duplicateKeys.has(key)) added.push(output);
  }

  const unkeyedPrevious = previous.filter((output) => sourceKey(output) === undefined);
  const unkeyedNext = next.filter((output) => sourceKey(output) === undefined);

  if (unkeyedPrevious.length === 1 && unkeyedNext.length === 1) {
    const oldOutput = unkeyedPrevious[0];
    const newOutput = unkeyedNext[0];
    if (oldOutput !== undefined && newOutput !== undefined) {
      if (oldOutput.kind === newOutput.kind) {
        preserved.push({
          guid: oldOutput.guid,
          oldKey: topologyKey(oldOutput),
          newKey: topologyKey(newOutput),
        });
      } else {
        changedKind.push({
          guid: oldOutput.guid,
          oldKind: oldOutput.kind,
          newKind: newOutput.kind,
          action: 'remove-add',
        });
        removed.push(oldOutput);
        added.push(newOutput);
      }
    }
  } else if (unkeyedPrevious.length > 0 || unkeyedNext.length > 0) {
    ambiguous.push({
      reason:
        unkeyedPrevious.length > 1 || unkeyedNext.length > 1
          ? 'source-index-ambiguous'
          : 'missing-source-key',
      previous: unkeyedPrevious,
      next: unkeyedNext,
    });
  }

  return { preserved, added, removed, changedKind, ambiguous };
}

export const calculateTopologyDiff = diffTopology;

/** Alias named after the producer-facing contract wording. */
