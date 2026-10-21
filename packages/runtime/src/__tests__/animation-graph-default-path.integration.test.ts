import { AnimationPlayer, animationPlugin, defineAnimationGraph } from '@forgeax/engine-animation';
import { createWorldContext, type EntityHandle, World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { testAssets } from './helpers/runtime-assets';

function registerClip(world: World, duration: number) {
  const clip: AnimationClip = { kind: 'animation-clip', duration, channels: [] };
  return testAssets(world).create(clip).unwrap();
}

describe('DAG eval — default animationPlugin path (M3 / w23, AC-09)', () => {
  it('auto-evaluates a graph carrier on world.update() with no opt-in', async () => {
    const world = new World();

    const walk = registerClip(world, 10);
    const run = registerClip(world, 10);
    const context = await createWorldContext(world, [animationPlugin()]);
    const built = defineAnimationGraph((b) => b.blend([b.clip(walk), b.clip(run)]));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const graphH = testAssets(world).create(built.value).unwrap();

    const e = world
      .spawn({ component: AnimationPlayer, data: { graph: graphH } })
      .unwrap() as EntityHandle;

    // Drive ONE frame through the default schedule. No manual eval call.
    world.update().unwrap();
    expect(world.execution.health).toBe('healthy');

    // The default plugin's evaluateAnimationGraph ran before advance and filled
    // the derived weights[] with the normalized [0.5, 0.5] distribution.
    const ap = world.get(e, AnimationPlayer).unwrap() as unknown as { weights: Float32Array };
    expect(ap.weights.length).toBe(2);
    expect(ap.weights[0]).toBeCloseTo(0.5, 5);
    expect(ap.weights[1]).toBeCloseTo(0.5, 5);
    await context.fiber.dispose();
    testAssets(world).dispose();
  });
});
