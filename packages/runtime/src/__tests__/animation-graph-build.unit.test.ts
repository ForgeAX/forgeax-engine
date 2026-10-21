import { defineAnimationGraph } from '@forgeax/engine-animation';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { expect, it } from 'vitest';
import { testAssets } from './helpers/runtime-assets';

const GraphHolder = defineComponent('AnimationGraphHolderW9', { graph: 'asset<animation-graph>' });

it('constructs a nested Clip/Blend/Add graph without error', () => {
  const graph = defineAnimationGraph((b) => {
    const walk = b.clip('walk'),
      run = b.clip('run'),
      survey = b.clip('survey');
    const locomotion = b.blend([walk, run]);
    const base = b.blend([survey, locomotion]);
    return b.add(base, [b.clip('overlay', 0.3)]);
  }).unwrap();
  expect(graph.kind).toBe('animation-graph');
  expect(graph.nodes).toHaveLength(7);
  expect(graph.nodes[graph.root]?.type).toBe('add');
});

it('creates one managed graph reference and releases its clip with the final owner', () => {
  const world = new World(),
    assets = testAssets(world);
  try {
    const clip = assets.create({ kind: 'animation-clip', duration: 10, channels: [] }).unwrap();
    const graph = assets.create(defineAnimationGraph((b) => b.clip(clip)).unwrap()).unwrap();
    expect(graph).toBeGreaterThan(0);
    assets.release(clip).unwrap();
    expect(assets.read(clip).ok).toBe(true);
    assets.release(graph).unwrap();
    expect(assets.read(graph).ok).toBe(false);
    expect(assets.read(clip).ok).toBe(false);
  } finally {
    assets.dispose();
  }
});

it('shares one graph across two entities and retains its clip until both retire', () => {
  const world = new World(),
    assets = testAssets(world);
  try {
    const clip = assets.create({ kind: 'animation-clip', duration: 10, channels: [] }).unwrap();
    const graph = assets
      .create(defineAnimationGraph((b) => b.blend([b.clip(clip), b.clip(clip)])).unwrap())
      .unwrap();
    const first = world.spawn({ component: GraphHolder, data: { graph } }).unwrap();
    const second = world.spawn({ component: GraphHolder, data: { graph } }).unwrap();
    assets.release(clip).unwrap();
    assets.release(graph).unwrap();
    world.despawn(first).unwrap();
    expect(world.get(second, GraphHolder).unwrap().graph).toBe(graph);
    expect(assets.read(graph).ok).toBe(true);
    expect(assets.read(clip).ok).toBe(true);
    world.despawn(second).unwrap();
    expect(assets.read(graph).ok).toBe(false);
    expect(assets.read(clip).ok).toBe(false);
  } finally {
    assets.dispose();
  }
});
