// feat-20260713-animation-state-machine-plugin M3 / w22 — clip-missing
// structured error (AC-11).
//
// AC-11 (clip-missing branch): when a graph node references a shared<AnimationClip>
// whose handle does not resolve (never registered, or rc released), evaluation
// fails with a structured `animation-graph-clip-missing` error carrying a
// machine-readable `.code` / `.hint` — and it must NOT leave a dirty pose (the
// derived slot columns stay untouched). AI users self-repair by property access,
// not string parsing (charter P3).
//
// TDD red anchor: before w24 + w25 the file fails to compile; after them a
// dangling clip handle throws the structured error before any slot is written.

import {
  AnimationPlayer,
  defineAnimationGraph,
  evaluateAnimationGraph,
} from '@forgeax/engine-animation';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

interface StructuredError {
  code?: unknown;
  hint?: unknown;
}

describe('evaluateAnimationGraph — clip-missing structured error (M3 / w22)', () => {
  it('throws animation-asset-not-found and writes no dirty pose', () => {
    const world = new World();

    // A durable clip GUID that was never loaded. Construction only validates
    // topology, so a single-clip graph with a dangling GUID is a
    // well-formed DAG that fails at evaluation, not at build.
    const danglingClip = 'test/dangling-animation-clip';
    const built = defineAnimationGraph((b) => b.clip(danglingClip));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const graphH = world.allocSharedRef('AnimationGraph', built.value);

    const e = world
      .spawn({ component: AnimationPlayer, data: { graph: graphH } })
      .unwrap() as EntityHandle;

    let caught: StructuredError | undefined;
    try {
      evaluateAnimationGraph(world, 0);
    } catch (err) {
      caught = err as StructuredError;
    }

    expect(caught).toBeDefined();
    expect(caught?.code).toBe('animation-asset-not-found');
    expect(typeof caught?.hint).toBe('string');
    expect((caught?.hint as string).length).toBeGreaterThan(0);

    // No dirty pose: eval resolves every clip BEFORE writing, so the derived
    // slot columns were never touched (still empty from the spawn default).
    const ap = world.get(e, AnimationPlayer).unwrap() as unknown as { weights: Float32Array };
    expect(ap.weights.length).toBe(0);
  });
});
