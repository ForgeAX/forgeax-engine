// feat-20260713-animation-state-machine-plugin M3 / w23 — default-path eval
// integration (AC-09).
//
// AC-09: DAG evaluation is wired into the DEFAULT animationPlugin (not an opt-in
// plugin). A host that lists the default animation capability gets automatic
// per-frame evaluation for free: spawn an entity carrying an AnimationGraph
// handle, drive a single world.update(), and read back the derived weights[] —
// no manual evaluateAnimationGraph() call anywhere. This mirrors the assemble
// form of createApp (a host-owned World running the default plugin set), the
// harshest headless surface of the "default plugin set" contract, matching the
// animationPlugin self-owns-resolver regression's approach.
//
// TDD red anchor: before w24 + w25 + w26 (plugin registers eval) the graph
// carrier never gets evaluated, so weights[] stays empty; after them the default
// plugin fills it automatically.

import { AnimationPlayer, animationPlugin, defineAnimationGraph } from '@forgeax/engine-animation';
import { createWorldContext, type EntityHandle, World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function registerClip(world: World, duration: number) {
  const clip: AnimationClip = { kind: 'animation-clip', duration, channels: [] };
  return world.allocSharedRef('AnimationClip', clip);
}

describe('DAG eval — default animationPlugin path (M3 / w23, AC-09)', () => {
  it('auto-evaluates a graph carrier on world.update() with no opt-in', async () => {
    const world = new World();

    // Build the DEFAULT animation capability onto a bare host World (assemble
    // form) — this is exactly what createApp's default plugin set does for the
    // animation subsystem.
    // Declare a normalizing Blend(Walk@1, Run@1) graph and register it + its
    // clips as ordinary payloads retained by the host-owned lookup.
    const clips = new Map<string, AnimationClip>([
      ['test/animation-clip-walk', { kind: 'animation-clip', duration: 10, channels: [] }],
      ['test/animation-clip-run', { kind: 'animation-clip', duration: 10, channels: [] }],
    ]);
    registerClip(world, 10);
    registerClip(world, 10);
    await createWorldContext(world, [animationPlugin((guid) => clips.get(guid))]);
    const built = defineAnimationGraph((b) =>
      b.blend([b.clip('test/animation-clip-walk'), b.clip('test/animation-clip-run')]),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const graphH = world.allocSharedRef('AnimationGraph', built.value);

    const e = world
      .spawn({ component: AnimationPlayer, data: { graph: graphH } })
      .unwrap() as EntityHandle;

    // Drive ONE frame through the default schedule. No manual eval call.
    world.update();
    expect(world.execution.health).toBe('healthy');

    // The default plugin's evaluateAnimationGraph ran before advance and filled
    // the derived weights[] with the normalized [0.5, 0.5] distribution.
    const ap = world.get(e, AnimationPlayer).unwrap() as unknown as { weights: Float32Array };
    expect(ap.weights.length).toBe(2);
    expect(ap.weights[0]).toBeCloseTo(0.5, 5);
    expect(ap.weights[1]).toBeCloseTo(0.5, 5);
  });
});
