import { assert, expect, it, vi } from 'vitest';
import { BatchSources, MemberCandidates } from '../gpu-driven/batch-members';
import { BatchTopology, type GpuDrivenBatch } from '../gpu-driven/batch-topology';
import { MeshBatchProjection } from '../gpu-driven/mesh-batches';
import { TreeFrame } from '../scene/frame-tree-list';
import { RenderScene } from '../scene/render-scene';
import { receiptRow } from './gpu-draw-selection-fixture';

function publication() {
  const scene = new RenderScene();
  scene.reset([receiptRow().source]);
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  return { topology, source: topology.sourcePlan() };
}
it('keeps Direct members fixed when public derived container root is replaced', () => {
  const { topology, source } = publication();
  const batch = required(source.batches.at(0));
  const members = required(batch.members);
  expect(Reflect.set(members, 'length', 0)).toBe(false);
  expect(Reflect.set(members, 'source', undefined)).toBe(false);
  const executed = topology.query(source, undefined);
  expect(executed.batches.at(0)?.members?.length).toBe(1);
  expect(executed.batches.at(0)?.members?.at(0)?.entityKey).toBe(42);
});
it('captures raw query facts and observes same-identity authored edits on the next query', () => {
  const { source } = publication();
  const member = required(source.batches.at(0));
  const original = required(required(member.binding).source);
  const draws = original.draws.map((draw) => ({
    ...draw,
    key: { ...draw.key },
    binding: { ...draw.binding },
    lod: { coverages: [1, 0.25], ranges: [{ first: 9, count: 3, baseVertex: 0 }] },
  }));
  const raw = {
    ...member,
    binding: { ...required(member.binding), source: { ...original, draws } },
  };
  const batches = new TreeFrame<GpuDrivenBatch>().with(raw, 0, raw.batchId, raw.candidates.length);
  const plan = { ...source, batches };
  const projection = new MeshBatchProjection();
  const held = projection.query(plan, undefined);
  required(draws[0]).key.count = 12;
  required(draws[0]).lod.coverages[1] = 0.5;
  required(required(draws[0]).lod.ranges[0]).count = 6;
  const latest = projection.query(plan, undefined);
  expect(held.batches.at(0)?.key.count).toBe(3);
  expect(held.batches.at(0)?.lod?.coverages[1]).toBe(0.25);
  expect(held.batches.at(0)?.lod?.ranges?.[0]?.count).toBe(3);
  expect(latest.batches.at(0)?.key.count).toBe(12);
  expect(latest.batches.at(0)?.lod?.coverages[1]).toBe(0.5);
  expect(latest.batches.at(0)?.lod?.ranges?.[0]?.count).toBe(6);
});
it('prevents numeric candidate and member alias edits from changing held facts', () => {
  const { source } = publication();
  const batch = required(source.batches.at(0));
  const candidates = batch.candidates as MemberCandidates;
  const candidate = required(candidates.at(0));
  Reflect.set(candidate, 'generation', 999);
  Reflect.set(required(batch.members?.at(0)), 'instanceCount', 999);
  expect(Reflect.set(required(candidates.root), 'weight', 999)).toBe(false);
  expect(candidates.at(0)?.generation).toBe(0);
  expect(candidates.length).toBe(1);
  expect(batch.members?.at(0)?.instanceCount).toBe(1);
});
it('retains fixed extent facts across 64/65 resize and generation replacement', () => {
  const member = {
    primitiveIndex: 9,
    generation: 1,
    entityKey: 42,
    drawItemIndex: 2,
    instanceCount: 64,
  };
  const before = new MemberCandidates().with(member),
    old = before.at(63);
  const grown = before.with({ ...member, instanceCount: 65 });
  const smaller = grown.with({ ...member, instanceCount: 64 });
  expect(grown.at(63)).toEqual(old);
  expect(smaller.at(63)).toEqual(old);
  expect(grown.at(64)).toEqual({ ...old, instanceOrdinal: 64 });
  expect(before.length).toBe(64);
  expect(grown.length).toBe(65);
  const replaced = grown.with({ ...member, generation: 2, instanceCount: 65 });
  expect(replaced.at(0)?.generation).toBe(2);
  expect(replaced.at(64)?.generation).toBe(2);
  expect(grown.at(0)?.generation).toBe(1);
});
it('seals only changed member paths instead of walking the retained tree', () => {
  let members = new MemberCandidates();
  for (let i = 0; i < 4096; i++)
    members = members.with({
      primitiveIndex: i,
      generation: 0,
      entityKey: i,
      drawItemIndex: 0,
      instanceCount: 1,
    });
  const old = members.at(-1),
    freeze = vi.spyOn(Object, 'freeze'),
    inspect = vi.spyOn(Object, 'isFrozen');
  try {
    const next = members.without(2048);
    expect(freeze.mock.calls.length).toBeLessThan(128);
    expect(inspect.mock.calls.length).toBeLessThan(256);
    expect(next.length).toBe(4095);
    expect(next.at(-1)).toEqual(old);
    expect(members.length).toBe(4096);
  } finally {
    freeze.mockRestore();
    inspect.mockRestore();
  }
});
it('rejects external tree injection into the canonical member owner', () => {
  expect(() => Reflect.construct(MemberCandidates, [{}])).toThrow(TypeError);
});
it('publishes the exact candidate owner checked from a single raw getter read', () => {
  const { source } = publication(),
    batch = required(source.batches.at(0));
  let reads = 0;
  const raw = {
    ...batch,
    get candidates() {
      return ++reads === 1 ? batch.candidates : [];
    },
  };
  const accepted = required(new BatchSources().with(raw).at(0));
  expect(reads).toBe(1);
  expect(accepted.candidates).toBe(batch.candidates);
  expect(accepted.candidates.length).toBe(1);
});

function required<T>(value: T | undefined): T {
  assert(value !== undefined);
  return value;
}

it('keeps shared source binding facts when only one member is removed', () => {
  const source = receiptRow().source,
    scene = new RenderScene();
  scene.reset([source, { ...source, entityKey: source.entityKey + 1 }]);
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const before = topology.sourcePlan(),
    held = required(before.batches.at(0));
  topology.apply(
    scene.apply([{ kind: 'remove', worldId: source.worldId, entityKey: source.entityKey + 1 }]),
  );
  const current = required(topology.sourcePlan().batches.at(0));
  expect(current.binding).toBe(held.binding);
  expect(current.key).toBe(held.key);
  expect(current.candidates.length).toBe(1);
  expect(held.candidates.length).toBe(2);
});
