import {
  AnimationPlayer,
  defineAnimationGraph,
  evaluateAnimationGraph,
} from '@forgeax/engine-animation';
import { World } from '@forgeax/engine-ecs';
import { expect, it } from 'vitest';
import { testAssets } from './helpers/runtime-assets';

it('rejects a missing clip before graph adoption and preserves the accepted playback slots', () => {
  const world = new World(),
    assets = testAssets(world);
  try {
    const clip = assets.create({ kind: 'animation-clip', duration: 10, channels: [] }).unwrap();
    const graph = assets.create(defineAnimationGraph((b) => b.clip(clip)).unwrap()).unwrap();
    const entity = world.spawn({ component: AnimationPlayer, data: { graph } }).unwrap();
    evaluateAnimationGraph(world, 0);
    const before = world.get(entity, AnimationPlayer).unwrap();
    const missing = defineAnimationGraph((b) => b.clip('test/dangling-animation-clip')).unwrap();
    const result = assets.replace(graph, missing);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'asset-not-found', hint: expect.any(String) },
    });
    expect(assets.read(graph).unwrap().nodes).toEqual([{ type: 'clip', clip, weight: 1 }]);
    expect(world.get(entity, AnimationPlayer).unwrap()).toEqual(before);
    evaluateAnimationGraph(world, 0);
    expect(world.get(entity, AnimationPlayer).unwrap().weights).toEqual(new Float32Array([1]));
  } finally {
    assets.dispose();
  }
});
