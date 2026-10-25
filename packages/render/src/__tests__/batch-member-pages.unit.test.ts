import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { MemberCandidates } from '../gpu-driven/batch-members';
import type { GpuDrivenBatchMember } from '../gpu-driven/batch-topology';
import { GpuSceneInputs } from '../gpu-scene-inputs';

function member(slot: number, instanceCount = 1, generation = 1): GpuDrivenBatchMember {
  return { primitiveIndex: slot, generation, entityKey: slot * 3, drawItemIndex: 0, instanceCount };
}

function filled(count: number, stride = 1): MemberCandidates {
  let members = new MemberCandidates();
  for (let index = 0; index < count; index++) members = members.with(member(index * stride));
  return members;
}

/** Deterministic xorshift, so a failure replays. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function expected(reference: ReadonlyMap<number, GpuDrivenBatchMember>): string[] {
  return [...reference.values()]
    .sort((left, right) => left.primitiveIndex - right.primitiveIndex)
    .flatMap((value) =>
      Array.from({ length: value.instanceCount }, (_, lane) => `${value.primitiveIndex}:${lane}`),
    );
}

describe('paged batch membership', () => {
  it('holds one tree node per page of members, not per member', () => {
    const members = filled(100_000);
    expect(members.memberCount).toBe(100_000);
    expect(members.length).toBe(100_000);
    // Ascending admission fills whole 64-member pages.
    expect(members.root?.size ?? 0).toBe(Math.ceil(100_000 / 64));
    // Interior inserts split full pages into halves.
    let interleaved = new MemberCandidates();
    for (let slot = 0; slot < 4_096; slot++) interleaved = interleaved.with(member(slot * 2));
    for (let slot = 0; slot < 4_096; slot++) interleaved = interleaved.with(member(slot * 2 + 1));
    expect(interleaved.memberCount).toBe(8_192);
    expect(interleaved.root?.size ?? 0).toBeLessThanOrEqual(Math.ceil(8_192 / 32));
    const removed = Array.from({ length: 100_000 }, (_, slot) => slot).filter(
      (slot) => slot % 8 !== 0,
    );
    let sparse = members;
    for (const slot of removed) sparse = sparse.without(slot);
    expect(sparse.memberCount).toBe(12_500);
    // Underfull pages merge into their successor.
    expect(sparse.root?.size ?? 0).toBeLessThanOrEqual(Math.ceil(12_500 / 16) + 1);
  });

  it('matches an ordered reference under add, remove, move and resize churn', () => {
    const next = random(7);
    const reference = new Map<number, GpuDrivenBatchMember>();
    let members = new MemberCandidates();
    for (let step = 0; step < 6_000; step++) {
      const slot = Math.floor(next() * 600);
      const before = members;
      const roll = next();
      if (roll < 0.55) {
        const value = member(slot, 1 + Math.floor(next() * 3), 1 + (step % 3));
        members = members.with(value);
        reference.set(slot, value);
      } else if (roll < 0.9) {
        members = members.without(slot);
        reference.delete(slot);
      } else {
        // A move: the slot leaves and another arrives in the same edit window.
        const target = (slot + 301) % 600;
        const value = member(target);
        members = members.without(slot).with(value);
        reference.delete(slot);
        reference.set(target, value);
      }
      const visited: number[] = [];
      members.changesSince(before, (changed, left, right) => {
        visited.push(changed);
        expect(left).toEqual(before.get(changed));
        expect(right).toEqual(members.get(changed));
        expect(left).not.toEqual(right);
      });
      expect(visited.length).toBeLessThanOrEqual(2);
      if (step % 500 === 0 || step === 5_999) {
        const walked = [...members].map((c) => `${c.primitiveIndex}:${c.instanceOrdinal}`);
        expect(walked).toEqual(expected(reference));
        expect(members.memberCount).toBe(reference.size);
        expect(members.length).toBe(walked.length);
        for (let index = 0; index < members.length; index += 17) {
          const candidate = members.at(index);
          expect(`${candidate?.primitiveIndex}:${candidate?.instanceOrdinal}`).toBe(walked[index]);
        }
        expect([...members.membersFrame()]).toEqual(
          [...reference.values()].sort((a, b) => a.primitiveIndex - b.primitiveIndex),
        );
      }
    }
  });

  it('diffs across page splits and merges by slot, not by page', () => {
    const base = filled(64);
    const split = base.with(member(1_000));
    const visits: [number, boolean, boolean][] = [];
    split.changesSince(base, (slot, left, right) =>
      visits.push([slot, left !== undefined, right !== undefined]),
    );
    expect(visits).toEqual([[1_000, false, true]]);
    let merged = split;
    for (let slot = 0; slot < 60; slot++) merged = merged.without(slot);
    visits.length = 0;
    merged.changesSince(split, (slot, left, right) =>
      visits.push([slot, left !== undefined, right !== undefined]),
    );
    expect(visits).toEqual(Array.from({ length: 60 }, (_, slot) => [slot, true, false]));
  });

  it('intersects ascending slots with held members across pages', () => {
    const members = filled(1_000, 3);
    const slots = [0, 1, 3, 190, 191, 192, 1_500, 2_997, 2_998, 5_000];
    const out: number[] = [];
    members.heldSlots(slots, out);
    expect(out).toEqual(slots.filter((slot) => members.get(slot) !== undefined));
    expect(out).toEqual([0, 3, 192, 1_500, 2_997]);
    out.length = 0;
    new MemberCandidates().heldSlots(slots, out);
    expect(out).toEqual([]);
  });

  it('patches a selected subset to equal a fresh selection', () => {
    const members = filled(5_000);
    const keep = (slot: number) => slot % 3 !== 0;
    const subset = members.selectMembers(keep);
    expect(subset.memberCount).toBe(3_333);
    const flipped = new Set([3, 4, 300, 2_999, 4_998]);
    const after = (slot: number) => (flipped.has(slot) ? !keep(slot) : keep(slot));
    const patched = members.patchSelection(subset, flipped, after);
    expect([...patched]).toEqual([...members.selectMembers(after)]);
    expect(members.patchSelection(subset, [], keep)).toBe(subset);
  });

  it('bounds one membership edit by one page and its tree path at any population', () => {
    const touched = (members: MemberCandidates, slot: number) => {
      let pages = 0;
      const freeze = Object.freeze;
      let frozen = 0;
      Object.freeze = ((value: unknown) => {
        frozen++;
        return freeze(value);
      }) as typeof Object.freeze;
      try {
        const added = members.with(member(slot));
        const removed = added.without(slot);
        added.changesSince(members, () => pages++);
        removed.changesSince(added, () => pages++);
      } finally {
        Object.freeze = freeze;
      }
      return { pages, frozen };
    };
    const small = touched(filled(4_096, 2), 2_049);
    const large = touched(filled(262_144, 2), 131_073);
    expect(small.pages).toBe(2);
    expect(large.pages).toBe(2);
    // Path copies grow with log(pages); members are never visited.
    expect(large.frozen).toBeLessThan(small.frozen + 64);
  });
});

describe('paged GPU member encoding', () => {
  async function uploadAfterEdits(population: number, edits: number) {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const inputs = new GpuSceneInputs(device, (slot) => slot);
    try {
      let members = filled(population, 2);
      const encode = (candidates: MemberCandidates) => {
        const frame = inputs.capture();
        frame.members(candidates);
        frame.buffer().unwrap();
        frame.seal().unwrap();
        return frame;
      };
      const held = encode(members);
      const nodes = inputs.memberNodesWritten;
      const bytes = inputs.uploadBytes;
      for (let edit = 0; edit < edits; edit++) {
        const slot = Math.floor((population * 2 * (edit + 0.5)) / edits) | 1;
        members = edit % 2 === 0 ? members.with(member(slot)) : members.without(slot - 1);
      }
      const next = encode(members);
      const result = {
        nodes: inputs.memberNodesWritten - nodes,
        bytes: inputs.uploadBytes - bytes,
      };
      next.release();
      held.release();
      return result;
    } finally {
      inputs.dispose();
    }
  }

  it('uploads changed pages and their paths, independent of the population', async () => {
    const small = await uploadAfterEdits(8_192, 8);
    const large = await uploadAfterEdits(262_144, 8);
    // Each edit writes one record page plus a treap path of node headers.
    expect(small.nodes).toBeLessThanOrEqual(8 * 48);
    expect(large.nodes).toBeLessThanOrEqual(8 * 48);
    expect(large.bytes).toBeLessThan(small.bytes * 2);
    expect(large.bytes).toBeLessThan(8 * 4_096);
    const one = await uploadAfterEdits(262_144, 1);
    expect(large.bytes).toBeGreaterThan(one.bytes * 3);
  }, 120_000);
});
