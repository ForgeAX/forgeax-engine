// feat-20260713-animation-state-machine-plugin M2 / w11 — describeAnimationGraph
// machine-readable introspection (AC-12).
//
// AC-12 + plan §8.4: describeAnimationGraph(g) enumerates the graph's nodes,
// topology (per-node children), root, and per-node static weights so an AI user
// discovers the graph structure WITHOUT reading implementation source (mirrors
// the getRegisteredComponents reflection idiom, research Finding H). The
// returned set must match the declared graph item-for-item.
//
// TDD red anchor: describeAnimationGraph does not exist before w15; the file
// fails to compile. After w15 the introspection matches the declaration.

import { defineAnimationGraph, describeAnimationGraph } from '@forgeax/engine-animation';
import { describe, expect, it } from 'vitest';

function clipGuid(id: number) {
  return `test/animation-clip-${id}`;
}

describe('describeAnimationGraph — introspection (M2 / w11)', () => {
  it('enumerates nodes, root, and static weights matching the declaration', () => {
    const result = defineAnimationGraph((b) => {
      const walk = b.clip(clipGuid(1), 1);
      const run = b.clip(clipGuid(2), 1);
      const loco = b.blend([walk, run], 0.4);
      const overlay = b.clip(clipGuid(3), 0.3);
      return b.add(loco, [overlay], 1);
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const desc = describeAnimationGraph(result.value);

    // 3 clips + 1 blend + 1 add = 5 nodes; root is the add (index 4).
    // Enumeration is CONSTRUCTION order (verbatim builder order), which is the
    // same index space as the runtime AnimationPlayer.nodeWeights knobs — so an
    // AI driving by desc.index writes the correct slot (V-1 fix: no reordering).
    // Construction order: walk(0) run(1) loco/blend(2) overlay(3) add/root(4).
    expect(desc.nodes.length).toBe(5);
    expect(desc.root).toBe(4);

    // Per-node type enumeration, construction order.
    expect(desc.nodes.map((n) => n.type)).toEqual(['clip', 'clip', 'blend', 'clip', 'add']);

    // Static weights read back item-for-item as declared, construction order.
    expect(desc.staticWeights).toEqual([1, 1, 0.4, 0.3, 1]);
    expect(desc.nodes.map((n) => n.weight)).toEqual([1, 1, 0.4, 0.3, 1]);

    // desc.index equals the construction position for every node (== nodeWeights slot).
    expect(desc.nodes.map((n) => n.index)).toEqual([0, 1, 2, 3, 4]);

    // Topology: clips have no children; blend(2) lists its leaves [walk, run];
    // add(4) lists [base=loco, ...additive=overlay].
    expect(desc.nodes[0]?.children).toEqual([]);
    expect(desc.nodes[2]?.children).toEqual([0, 1]);
    expect(desc.nodes[4]?.children).toEqual([2, 3]);
  });

  it('exposes node index on each description entry', () => {
    const result = defineAnimationGraph((b) => b.clip(clipGuid(1)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const desc = describeAnimationGraph(result.value);
    expect(desc.nodes[0]?.index).toBe(0);
    expect(desc.root).toBe(0);
  });
});
