import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { MemberCandidates } from '../gpu-driven/batch-members';
import type { GpuDrivenBatch, SubmissionPlan } from '../gpu-driven/batch-topology';
import { ShadowChannelSlots } from '../gpu-driven/production-raster-shadow';
import {
  projectShadowLayer,
  type ShadowLayerProjection,
  type ShadowLayerWork,
} from '../gpu-driven/shadow-layer-projection';
import { GpuSceneInputs } from '../gpu-scene-inputs';
import { FrameSet } from '../scene/frame-set';
import type { RenderSceneSlot } from '../scene/render-scene-types';

const BATCHES = 4;
const FLIPS = 8;

function member(slot: number) {
  return {
    primitiveIndex: slot,
    generation: 1,
    entityKey: slot,
    drawItemIndex: 0,
    instanceCount: 1,
  };
}

function batch(batchId: number, candidates: MemberCandidates): GpuDrivenBatch {
  return Object.freeze({
    batchId,
    generation: 1,
    visibleBase: batchId * 65536,
    visibleCapacity: candidates.length,
    indirectOffset: batchId * 20,
    contentEpoch: 0,
    key: Object.freeze({
      assetHandle: 0,
      drawKind: 'indexed' as const,
      first: 0,
      count: 3,
      baseVertex: 0,
      materialSlot: 0,
      topology: 'triangle-list' as const,
      pipelineClass: 'fixture',
      materialResourceClass: 'fixture',
    }),
    candidates,
  });
}

function plan(batches: readonly GpuDrivenBatch[]): SubmissionPlan {
  return Object.freeze({
    revision: 1,
    batches: Object.freeze([...batches]),
    candidateCount: batches.reduce((count, row) => count + row.candidates.length, 0),
    visibleCapacity: 65536 * batches.length,
  });
}

/** `size` slots split into contiguous batches, with every slot selected. */
function scene(size: number) {
  const per = size / BATCHES;
  const batches = Array.from({ length: BATCHES }, (_, index) => {
    let members = new MemberCandidates();
    for (let slot = index * per; slot < (index + 1) * per; slot++)
      members = members.with(member(slot));
    return batch(index, members);
  });
  let selection = new FrameSet();
  for (let slot = 0; slot < size; slot++) selection = selection.with(slot);
  return { per, batches, source: plan(batches), selection };
}

function work(): ShadowLayerWork {
  return { layerSlotVisits: 0, layerBatchSelections: 0, layerBatchPatches: 0 };
}

function selectedSlots(projection: ShadowLayerProjection, batchId: number): number[] {
  const row = projection.batches.find((entry) => entry.batchId === batchId);
  return row === undefined ? [] : row.candidates.map((candidate) => candidate.primitiveIndex);
}

describe('incremental shadow layer projection', () => {
  it.each([
    2_048, 32_768,
  ])('patches %i casters in work bounded by flips and member edits', (size) => {
    const { per, batches, source, selection } = scene(size);
    const initial = projectShadowLayer(undefined, source, selection, work());
    expect(initial.candidateCount).toBe(size);
    // Every batch selects all members: rows borrow the source rows themselves.
    expect(initial.batches).toEqual(batches);
    for (const [index, row] of initial.batches.entries()) expect(row).toBe(batches[index]);

    // Eight casters of the first two batches turn dynamic.
    const flipped = Array.from({ length: FLIPS }, (_, index) => (index % 2) * per + 3 + index);
    let next = selection;
    for (const slot of flipped) next = next.without(slot);
    const flipWork = work();
    const patched = projectShadowLayer(initial, source, next, flipWork);
    expect(flipWork).toEqual({
      layerSlotVisits: FLIPS,
      layerBatchSelections: 0,
      layerBatchPatches: 2,
    });
    expect(patched.candidateCount).toBe(size - FLIPS);
    expect(patched.batches[2]).toBe(initial.batches[2]);
    expect(patched.batches[3]).toBe(initial.batches[3]);
    expect(selectedSlots(patched, 0)).toEqual(
      Array.from({ length: per }, (_, slot) => slot).filter((slot) => !flipped.includes(slot)),
    );
    expect(patched.drawn.has(flipped[0] as number)).toBe(false);
    expect(patched.drawn.has(per * 3)).toBe(true);

    // Churn in batch 1 replaces one member; only the edited paths are re-judged.
    const edited = (batches[1]?.candidates as MemberCandidates)
      .without(per + 20)
      .with(member(size + 1));
    const churned = plan(batches.map((row, index) => (index === 1 ? batch(1, edited) : row)));
    const churnWork = work();
    const churn = projectShadowLayer(patched, churned, next.with(size + 1), churnWork);
    expect(churnWork.layerBatchSelections).toBe(0);
    // The added slot is judged once as a selection change and once as a member edit.
    expect(churnWork.layerSlotVisits).toBe(2);
    expect(selectedSlots(churn, 1)).toContain(size + 1);
    expect(selectedSlots(churn, 1)).not.toContain(per + 20);
    expect(churn.batches[0]).toBe(patched.batches[0]);
    expect(churn.batches[2]).toBe(initial.batches[2]);
  });

  it.each([
    1_024, 8_192,
  ])('patches only the %i-batch singleton subsets that hold a flipped slot', (count) => {
    // One member per batch (per-entity deformed geometry): flips must not
    // re-judge every batch against every changed slot.
    const batches = Array.from({ length: count }, (_, slot) =>
      batch(slot, new MemberCandidates().with(member(slot))),
    );
    const source = plan(batches);
    let selection = new FrameSet();
    for (let slot = 0; slot < count; slot++) selection = selection.with(slot);
    const initial = projectShadowLayer(undefined, source, selection, work());
    const flipped = Array.from({ length: FLIPS }, (_, index) => index * 97 + 5);
    let next = selection;
    for (const slot of flipped) next = next.without(slot);
    const flipWork = work();
    const patched = projectShadowLayer(initial, source, next, flipWork);
    expect(flipWork).toEqual({
      layerSlotVisits: FLIPS,
      layerBatchSelections: 0,
      layerBatchPatches: FLIPS,
    });
    expect(patched.candidateCount).toBe(count - FLIPS);
    for (const slot of flipped) expect(selectedSlots(patched, slot)).toEqual([]);
    expect(selectedSlots(patched, 6)).toEqual([6]);
  });

  it('answers drawn slots like the batch scan before and after it indexes them', () => {
    let seed = 0x2f6b;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const size = 600;
    const batches = Array.from({ length: 12 }, (_, batchId) => {
      let members = new MemberCandidates();
      for (let slot = 0; slot < size; slot++)
        if (next() < 0.08)
          members = members.with({ ...member(slot), instanceCount: Math.floor(next() * 3) });
      return batch(batchId, members);
    });
    let selection = new FrameSet();
    for (let slot = 0; slot < size; slot++) if (next() < 0.7) selection = selection.with(slot);
    const projection = projectShadowLayer(undefined, plan(batches), selection, work());
    const scanned = (slot: number) =>
      projection.batches.some(
        (row) => ((row.candidates as MemberCandidates).get(slot)?.instanceCount ?? 0) > 0,
      );
    let drawn = 0;
    // Enough lookups to exhaust the scan budget, so both answer paths run.
    for (let round = 0; round < 3; round++)
      for (let slot = -2; slot < size + 2; slot++) {
        expect(projection.drawn.has(slot)).toBe(scanned(slot));
        if (round === 0 && scanned(slot)) drawn++;
      }
    expect(drawn).toBeGreaterThan(0);
  });

  it('keeps an absent batch dormant and restores it without walking its members', () => {
    const { batches, source, selection } = scene(4_096);
    const initial = projectShadowLayer(undefined, source, selection, work());
    const absentWork = work();
    const absent = projectShadowLayer(initial, plan(batches.slice(0, 3)), selection, absentWork);
    expect(absent.batches).toHaveLength(3);
    expect(absent.membershipKnown).toBe(true);
    const restoredWork = work();
    const restored = projectShadowLayer(absent, source, selection.without(5), restoredWork);
    expect(restoredWork).toEqual({
      layerSlotVisits: 1,
      layerBatchSelections: 0,
      layerBatchPatches: 1,
    });
    expect(restored.batches[3]).toBe(initial.batches[3]);
  });

  it.each([
    2_048, 32_768,
  ])('re-encodes only the patched paths of a held %i-member subset', async (size) => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const inputs = new GpuSceneInputs(device, (slot) => slot);
    try {
      const { per, source, selection } = scene(size);
      let without = selection;
      for (let slot = 0; slot < per; slot += per / 4) without = without.without(slot);
      const base = projectShadowLayer(undefined, source, without, work());
      const subset = base.batches[0]?.candidates as MemberCandidates;
      const release = inputs.holdMembers(subset);
      const written = inputs.memberNodesWritten;
      let flipped = without;
      for (let index = 0; index < FLIPS; index++) flipped = flipped.without(7 + index * 5);
      const next = projectShadowLayer(base, source, flipped, work());
      const reads = inputs.capture();
      reads.members(next.batches[0]?.candidates as MemberCandidates);
      // Each flip copies one treap path, independent of the subset size.
      expect(inputs.memberNodesWritten - written).toBeLessThan(FLIPS * 48);
      reads.release();
      release();
    } finally {
      inputs.dispose();
    }
  });
});

describe('caster channel membership', () => {
  it('enumerates scene slots once per mask and then follows the change journal', () => {
    const rows = new Map<number, RenderSceneSlot>();
    const row = (slot: number, shadowChannels: number) =>
      ({ slot, snapshot: { shadowChannels } }) as unknown as RenderSceneSlot;
    for (let slot = 0; slot < 1_000; slot++) rows.set(slot, row(slot, slot % 2 === 0 ? 1 : 2));
    let enumerations = 0;
    let revision = 1;
    let changed: number[] = [];
    const source = {
      get slots() {
        enumerations++;
        return [...rows.values()] as never;
      },
      slotAt: (slot: number) => rows.get(slot),
    };
    const journal = {
      get contentRevision() {
        return revision;
      },
      changedSlotsSince: (since: number) => (since === revision - 1 ? changed : undefined),
    };
    const channels = new ShadowChannelSlots();
    const even = channels.select(1, source, journal);
    expect(even.size).toBe(500);
    expect(channels.select(1, source, journal)).toBe(even);
    rows.set(1, row(1, 3));
    rows.delete(2);
    changed = [1, 2];
    revision++;
    const patched = channels.select(1, source, journal);
    expect(enumerations).toBe(1);
    expect(patched.has(1)).toBe(true);
    expect(patched.has(2)).toBe(false);
    expect(patched.size).toBe(500);
    revision += 2;
    channels.select(1, source, journal);
    expect(enumerations).toBe(2);
  });
});
