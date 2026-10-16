// Regression test for a bug fixed 2026-07-27 (feedback:
// advance-animation-player-hardcoded-fixed-dt-ignores-time-delta): the
// `AdvanceAnimationPlayer` / `EvaluateAnimationGraph` system tokens used to call
// their pure functions with a literal `1 / 60` instead of the World's real
// `Time.delta`, so animation played back at the wrong speed whenever
// `world.update(dt)` was driven at anything other than exactly 60Hz.
//
// These tests drive `world.update(dt)` at 30Hz / 60Hz / 120Hz through the real
// default-plugin schedule (not by calling `advanceAnimationPlayer` /
// `evaluateAnimationGraph` directly with an explicit `dt` — that would only
// prove the pure functions are dt-aware, not that the systems wire the real
// frame time into them) and assert the advanced time columns scale with the
// driven `dt`, not with a fixed `1 / 60`.

import type { EntityHandle } from '@forgeax/engine-ecs';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import { defineAnimationGraph } from '../graph/define-animation-graph';
import { animationPlugin } from '../plugin';

function registerClip(world: World, duration: number) {
  const clip: AnimationClip = { kind: 'animation-clip', duration, channels: [] };
  return world.allocSharedRef('AnimationClip', clip);
}

const FRAME_RATES_HZ = [30, 60, 120] as const;

describe('animation systems honor real Time.delta (regression: hardcoded 1/60)', () => {
  it.each(
    FRAME_RATES_HZ,
  )('advanceAnimationPlayer advances times[0] by the real dt at %iHz, not a fixed 1/60', async (hz) => {
    const dt = 1 / hz;
    const world = new World();
    await createWorldContext(world, [animationPlugin()]);

    const clip = registerClip(world, 10);
    const e = world
      .spawn({
        component: AnimationPlayer,
        data: { clips: [clip], times: [0], weights: [1], speeds: [1] },
      })
      .unwrap() as EntityHandle;

    world.update(dt);

    const ap = world.get(e, AnimationPlayer).unwrap() as unknown as { times: Float64Array };
    expect(ap.times[0]).toBeCloseTo(dt, 5);
  });

  it.each(
    FRAME_RATES_HZ,
  )('evaluateAnimationGraph advances nodeTimes[0] by the real dt at %iHz, not a fixed 1/60', async (hz) => {
    const dt = 1 / hz;
    const world = new World();
    const clipPayload: AnimationClip = { kind: 'animation-clip', duration: 10, channels: [] };
    await createWorldContext(world, [
      animationPlugin((guid) => (guid === 'test/animation-clip-delta' ? clipPayload : undefined)),
    ]);

    registerClip(world, 10);
    const built = defineAnimationGraph((b) => b.clip('test/animation-clip-delta'));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const graphH = world.allocSharedRef('AnimationGraph', built.value);

    // `nodeSpeeds` defaults to 0 per node when unset (unlike `nodeWeights`,
    // which defaults to 1) — must be explicit or the clip node never advances.
    const e = world
      .spawn({ component: AnimationPlayer, data: { graph: graphH, nodeSpeeds: [1] } })
      .unwrap() as EntityHandle;

    world.update(dt);

    const ap = world.get(e, AnimationPlayer).unwrap() as unknown as { nodeTimes: Float64Array };
    expect(ap.nodeTimes[0]).toBeCloseTo(dt, 5);
  });
});
