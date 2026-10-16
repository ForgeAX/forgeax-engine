// feat-20260713-animation-state-machine-plugin M2 / w10 — illegal graph
// construction structured errors (AC-11 graph-structure branches).
//
// AC-11 + plan D-5: defineAnimationGraph validates topology at CONSTRUCTION time
// (before a GUID handle is minted) and returns Result.err with a structured
// `.code` / `.hint` for each illegal shape:
//   - node reference out of range  -> 'animation-graph-node-out-of-range'
//   - cycle                        -> 'animation-graph-cycle'
//   - node weight negative / NaN   -> 'animation-graph-node-weight-invalid'
//   - empty graph                  -> 'animation-graph-empty'
// AI users self-repair by property access — no string parsing (charter P3).
//
// TDD red anchor: defineAnimationGraph does not exist before w14; the file fails
// to compile. After w14 each illegal graph returns the matching structured code.

import { type AnimationGraphNodeRef, defineAnimationGraph } from '@forgeax/engine-animation';
import { describe, expect, it } from 'vitest';

function clipGuid(id: number) {
  return `test/animation-clip-${id}`;
}

// Cast a raw index to a node ref — the illegal-graph tests deliberately forge
// out-of-range / self-referential refs the well-behaved builder never emits.
function forgeRef(index: number): AnimationGraphNodeRef {
  return index as unknown as AnimationGraphNodeRef;
}

describe('AnimationGraph — illegal construction errors (M2 / w10)', () => {
  it('empty graph -> animation-graph-empty', () => {
    // The builder creates zero nodes; the returned root ref points nowhere.
    const result = defineAnimationGraph(() => forgeRef(0));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('animation-graph-empty');
    expect(typeof result.error.hint).toBe('string');
    expect(result.error.hint.length).toBeGreaterThan(0);
  });

  it('out-of-range child reference -> animation-graph-node-out-of-range', () => {
    const result = defineAnimationGraph((b) => {
      b.clip(clipGuid(1)); // node 0
      // A blend that references index 99 (nonexistent).
      return b.blend([forgeRef(99)]);
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('animation-graph-node-out-of-range');
    expect(result.error.hint.length).toBeGreaterThan(0);
  });

  it('cycle -> animation-graph-cycle', () => {
    // node 0 is a blend that references itself (index 0).
    const result = defineAnimationGraph((b) => b.blend([forgeRef(0)]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('animation-graph-cycle');
    expect(result.error.hint.length).toBeGreaterThan(0);
  });

  it('negative node weight -> animation-graph-node-weight-invalid', () => {
    const result = defineAnimationGraph((b) => b.clip(clipGuid(1), -0.5));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('animation-graph-node-weight-invalid');
    expect(result.error.hint.length).toBeGreaterThan(0);
  });

  it('NaN node weight -> animation-graph-node-weight-invalid', () => {
    const result = defineAnimationGraph((b) => b.clip(clipGuid(1), Number.NaN));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('animation-graph-node-weight-invalid');
  });
});
