import type { DerivedCandidateRecord } from './derived-candidate-records.js';

export interface DerivedAdmissionOrder {
  readonly ordered: readonly (readonly DerivedCandidateRecord[])[];
  /** Records reached again while their own group was still being visited. */
  readonly cyclic: readonly { readonly record: DerivedCandidateRecord; readonly key: string }[];
}

/** Latest queued revision per entity; dependency edges only follow these records. */
function latestByEntity(
  records: readonly DerivedCandidateRecord[],
): Map<number, DerivedCandidateRecord> {
  const latest = new Map<number, DerivedCandidateRecord>();
  for (const record of records) {
    const current = latest.get(record.input.entity);
    if (current === undefined || record.input.revision > current.input.revision)
      latest.set(record.input.entity, record);
  }
  return latest;
}

/**
 * A candidate that names a queued endpoint must be processed after that
 * endpoint. This turns a queue-time source projection into a final
 * committed-source check: if the endpoint fails natively, its dependent
 * candidate sees the old source on the next iteration and is rejected.
 */
export function orderDerivedCandidateGroups(
  records: readonly DerivedCandidateRecord[],
): DerivedAdmissionOrder {
  const pendingByEntity = latestByEntity(records);
  const ordered: (readonly DerivedCandidateRecord[])[] = [];
  const cyclic: { readonly record: DerivedCandidateRecord; readonly key: string }[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (record: DerivedCandidateRecord): void => {
    const group = record.batch?.records ?? [record];
    const key = group[0]?.token.candidateId ?? record.token.candidateId;
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      cyclic.push({ record, key });
      return;
    }
    visiting.add(key);
    for (const member of group)
      for (const constraint of member.input.constraints ?? [])
        for (const [entity, dependency] of [
          [constraint.bodyA, constraint.bodyASource],
          [constraint.bodyB, constraint.bodyBSource],
        ] as const) {
          const target = pendingByEntity.get(entity);
          if (
            target !== undefined &&
            !group.includes(target) &&
            target.input.sourceKey === dependency.sourceKey &&
            target.input.revision === dependency.revision
          )
            visit(target);
        }
    visiting.delete(key);
    visited.add(key);
    ordered.push(group);
  };
  for (const record of records) visit(record);
  return { ordered, cyclic };
}
