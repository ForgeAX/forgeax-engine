import { expect, it } from 'vitest';
import { MemberCandidates } from '../gpu-driven/batch-members';
import type { GpuDrivenBatch } from '../gpu-driven/batch-topology';
import { hasCapturedTaskMembership, hasFixedTaskHeaders } from '../gpu-driven/fixed-task-plan';
import { partitionBatch } from '../gpu-driven/production-raster-prepare';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

it('retains native subset roots only for the exact canonical member frame', () => {
  const f = createFilterPlanFixture({ sharedGeometry: true });
  const source = f.source.batches.at(0);
  if (source?.members === undefined) throw new Error('Missing source');
  const native = partitionBatch(source, f.bindings);
  expect(native).toHaveLength(2);
  for (const group of native) {
    expect(MemberCandidates.is(group.candidates)).toBe(true);
    expect(group.members).toBe((group.candidates as MemberCandidates).membersFrame());
  }
  const raw = partitionBatch(
    { ...source, members: source.members.map((row) => ({ ...row })) },
    f.bindings,
  );
  expect(raw).toHaveLength(2);
  expect(raw.every((group) => !MemberCandidates.is(group.candidates))).toBe(true);
  expect(native.map((group) => [...group.candidates])).toEqual(
    raw.map((group) => [...group.candidates]),
  );
});

it('does not combine three candidate getter observations into a canonical pair proof', () => {
  const f = createFilterPlanFixture({ sharedGeometry: true });
  const first = f.source.batches.at(0);
  if (first === undefined || !MemberCandidates.is(first.candidates))
    throw new Error('Missing native source');
  const a = first.candidates;
  const member = a.membersFrame().at(0);
  if (member === undefined) throw new Error('Missing member');
  const b = a.with({ ...member, generation: member.generation + 1 });
  const c = a.with({ ...member, generation: member.generation + 2 });
  let reads = 0;
  const roots = [a, b, c];
  const source: GpuDrivenBatch = {
    ...first,
    members: b.membersFrame(),
    get candidates() {
      const root = roots[Math.min(reads++, 2)];
      if (root === undefined) throw new Error('Missing observed root');
      return root;
    },
  };
  const groups = partitionBatch(source, new Map([['unused', 'unused']]));
  expect(groups).toHaveLength(1);
  expect(groups[0]?.candidates).toBe(a);
  expect(reads).toBe(1);
});

it('seals native task membership without granting encoded-header qualification', () => {
  const f = createFilterPlanFixture();
  expect(hasCapturedTaskMembership(f.source)).toBe(true);
  expect(hasFixedTaskHeaders(f.source)).toBe(false);
  expect(hasCapturedTaskMembership(Object.freeze({ ...f.source }))).toBe(false);
  const root = Reflect.get(f.source.batches, 'root');
  expect(root).toBeDefined();
  expect(Reflect.set(f.source.batches, 'root', undefined)).toBe(false);
  expect(Reflect.set(root, 'value', { batchId: 999 })).toBe(false);
  expect(f.source.batches.length).toBe(3);
});
