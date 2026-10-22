import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import type { GpuDrivenBatch, SubmissionPlan } from '../gpu-driven/batch-topology';
import { sameShadowLodLevels, shadowLodLevels } from '../gpu-driven/shadow-lod-selections';

function batch(instances: number, material = 'forgeax::default-standard-pbr') {
  const receipt = createStandardPbrArtifactReceipt();
  return {
    batchId: 1,
    generation: 1,
    contentEpoch: 1,
    visibleBase: 0,
    indirectOffset: 0,
    visibleCapacity: instances * 2,
    key: {
      assetHandle: 1,
      drawKind: 'indexed',
      first: 0,
      count: 3,
      baseVertex: 0,
      materialSlot: 0,
      topology: 'triangle-list',
      pipelineClass: 'fixture',
      materialResourceClass: 'fixture',
    },
    prepared: {
      identity: { material, geometry: 'fixture', deformation: 'rigid' },
      receiptGeneration: receipt.generation,
      directEntry: receipt.directEntry,
      sceneIndexEntry: receipt.sceneIndexEntry,
      materialRow: receipt.materialRow,
      resourceSlots: receipt.resourceSlots,
      uvSets: receipt.uvSets,
      vertexInputs: receipt.vertexInputs,
      alphaMask: receipt.alphaMask,

      topology: 'triangle-list',
      indexed: true,
      first: 0,
      count: 3,
      baseVertex: 0,
    },
    lod: {
      coverages: [1, 0.5, 0.25],
      hysteresis: 0.08,
      ranges: [
        { first: 3, count: 3, baseVertex: 0 },
        { first: 6, count: 3, baseVertex: 0 },
      ],
    },
    candidates: Array.from({ length: instances }, (_, instanceOrdinal) =>
      [0, 1].map((primitiveIndex) => ({
        primitiveIndex,
        generation: 1,
        drawItemIndex: 0,
        instanceOrdinal,
      })),
    ).flat(),
  } satisfies GpuDrivenBatch;
}
function selectedLevels(selection: ReturnType<typeof shadowLodLevels>, primitive: number) {
  const levels = selection.get(primitive);
  if (levels === undefined) throw new Error(`Missing fixture primitive ${primitive}`);
  return levels;
}
function plan(batches: readonly GpuDrivenBatch[]): SubmissionPlan {
  const count = batches.reduce((total, value) => total + value.candidates.length, 0);
  return { revision: 1, batches, candidateCount: count, visibleCapacity: count };
}

describe('retained shadow discrete LOD sequences', () => {
  it('selects each primitive once for 4096 instances and recomputes a mutated height map', () => {
    const source = plan([batch(4096)]);
    const heights = new Map([
      [0, 1],
      [1, 0.5],
    ]);
    const reads = vi.spyOn(heights, 'get');
    const initial = shadowLodLevels(source, heights);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(initial.get(0)).toEqual({ runs: [{ levels: [0], count: 4096 }], finest: 0 });
    expect(initial.get(1)).toEqual({ runs: [{ levels: [0, 1], count: 4096 }], finest: 0 });
    heights.set(0, 0.1);
    const next = shadowLodLevels(source, heights);
    expect(reads).toHaveBeenCalledTimes(4);
    expect(next.get(0)).toEqual({ runs: [{ levels: [2], count: 4096 }], finest: 2 });
    expect(sameShadowLodLevels(initial.get(0), selectedLevels(next, 0))).toBe(false);
    expect(sameShadowLodLevels(initial.get(1), selectedLevels(next, 1))).toBe(true);
  });

  it('preserves multiplicity and order while coalescing identical batch boundaries', () => {
    const source = batch(64);
    const heights = new Map([
      [0, 0.1],
      [1, 0.5],
    ]);
    const whole = shadowLodLevels(plan([source]), heights);
    const split = shadowLodLevels(
      plan([
        { ...source, candidates: source.candidates.slice(0, 64) },
        { ...source, batchId: 2, candidates: source.candidates.slice(64) },
      ]),
      heights,
    );
    expect(sameShadowLodLevels(whole.get(0), selectedLevels(split, 0))).toBe(true);
    const fewer = shadowLodLevels(plan([batch(32)]), heights);
    expect(sameShadowLodLevels(whole.get(0), selectedLevels(fewer, 0))).toBe(false);
    const coarse = batch(2),
      rootOnly = { ...batch(2), lod: { coverages: [1, 0.05] } };
    const forward = shadowLodLevels(plan([coarse, rootOnly]), heights);
    const reverse = shadowLodLevels(plan([rootOnly, coarse]), heights);
    expect(forward.get(0)?.finest).toBe(reverse.get(0)?.finest);
    expect(sameShadowLodLevels(forward.get(0), selectedLevels(reverse, 0))).toBe(false);
  });

  it('keeps absent heights safe, omits non-LOD primitives and respects resident crossfade levels', () => {
    const source = batch(1);
    expect(shadowLodLevels(plan([{ ...source, lod: { coverages: [1] } }]), undefined).size).toBe(0);
    expect(shadowLodLevels(plan([source]), undefined).get(0)?.finest).toBe(0);
    const unavailable = { ...source, lod: { ...source.lod, ranges: [] } };
    expect(
      shadowLodLevels(plan([unavailable]), new Map([[0, 0.5]])).get(0)?.runs[0]?.levels,
    ).toEqual([0]);
    const custom = shadowLodLevels(plan([batch(1, 'custom-shadow')]), new Map([[0, 0.5]]));
    expect(custom.get(0)?.runs[0]?.levels).toHaveLength(1);
    const skinned = {
      ...source,
      prepared: {
        ...source.prepared,
        identity: { ...source.prepared.identity, deformation: 'skin' as const },
      },
    };
    expect(
      shadowLodLevels(plan([skinned]), new Map([[0, 0.5]])).get(0)?.runs[0]?.levels,
    ).toHaveLength(1);
    expect(sameShadowLodLevels(undefined, selectedLevels(custom, 0))).toBe(false);
  });
});
