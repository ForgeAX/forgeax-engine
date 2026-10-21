import {
  AnimationPlayer,
  defineAnimationGraph,
  defineAnimationMask,
  deriveAnimationTargetId,
  evaluateAnimationGraph,
  serializeAnimationGraph,
} from '@forgeax/engine-animation';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { afterEach, describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { testAssets } from './helpers/runtime-assets';

const G_WALK = 'b1000000-0000-4000-8000-000000000001';
const G_RUN = 'b1000000-0000-4000-8000-000000000002';
const G_SURVEY = 'b1000000-0000-4000-8000-000000000003';
const G_GRAPH = 'b1000000-0000-4000-8000-0000000000aa';
const owners: AssetRegistry[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

async function fixture() {
  const world = new World();
  world.components.register(AnimationPlayer).unwrap();
  const assets = testAssets(world);
  owners.push(assets);
  const original = defineAnimationGraph((b) => {
    const walk = b.clip(G_WALK);
    const run = b.clip(G_RUN);
    const base = b.blend([walk, run]);
    const overlay = b.clip(G_SURVEY, 0.3);
    return b.add(base, [overlay]);
  }).unwrap();
  const serialized = serializeAnimationGraph(original);
  if (serialized === undefined) throw new Error('missing serialized graph');
  publishTestAssets(assets, [
    ...[G_WALK, G_RUN, G_SURVEY].map((guid, index) => ({
      guid,
      kind: 'animation-clip',
      payload: { kind: 'animation-clip', duration: (index + 1) * 10, channels: [] },
      refs: [],
      artifacts: {},
    })),
    { guid: G_GRAPH, kind: 'animation-graph', ...serialized, artifacts: {} },
  ]);
  const graph = (await assets.load(G_GRAPH, 'animation-graph')).unwrap();
  const clip = (await assets.load(G_WALK, 'animation-clip')).unwrap();
  return { world, assets, graph, clip, original };
}

function apOf(scene: {
  entities: Readonly<Record<string, unknown>>;
}): Record<string, unknown> | undefined {
  for (const entity of Object.values(scene.entities)) {
    const components = (entity as { components: Record<string, Record<string, unknown>> })
      .components;
    if (components.AnimationPlayer !== undefined) return components.AnimationPlayer;
  }
  return undefined;
}

describe('AnimationGraph collect and serialized Pack round-trip', () => {
  it('collects the graph through its ordinary schema field as a durable GUID', async () => {
    const { world, assets, graph } = await fixture();
    const entity = world
      .spawn({
        component: AnimationPlayer,
        data: { graph, nodeWeights: [1, 1, 1, 1, 1] },
      })
      .unwrap();
    const collected = rootsToSceneAsset(assets, world, [entity]).unwrap();
    expect(apOf(collected)?.graph).toBe(G_GRAPH);
  });

  it('keeps World-local masks transient while collecting ordinary playback assets', async () => {
    const { world, assets, clip } = await fixture();
    const mask = world.allocSharedRef(
      'AnimationMask',
      defineAnimationMask([
        { targetId: deriveAnimationTargetId(['Rig', 'Upper']), weight: 1 },
      ]).unwrap(),
    );
    const player = world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips: [clip],
          times: [0],
          weights: [1],
          speeds: [1],
          masks: [mask],
          nodeMasks: [mask],
        },
      })
      .unwrap();
    const data = apOf(rootsToSceneAsset(assets, world, [player]).unwrap());
    expect(data?.clips).toEqual([G_WALK]);
    expect(data).not.toHaveProperty('masks');
    expect(data).not.toHaveProperty('nodeMasks');
  });

  it('omits the absent graph sentinel without losing the player', async () => {
    const { world, assets } = await fixture();
    const entity = world
      .spawn({
        component: AnimationPlayer,
        data: { clips: [], times: [], weights: [], speeds: [] },
      })
      .unwrap();
    const data = apOf(rootsToSceneAsset(assets, world, [entity]).unwrap());
    expect(data).toBeDefined();
    expect(data).not.toHaveProperty('graph');
  });

  it('evaluates the serialized Pack graph to the same weights as the authored graph', async () => {
    const { world, assets, graph, original } = await fixture();
    const authored = assets.create(original).unwrap();
    const before = world.spawn({ component: AnimationPlayer, data: { graph: authored } }).unwrap();
    const after = world.spawn({ component: AnimationPlayer, data: { graph } }).unwrap();
    evaluateAnimationGraph(world, 1 / 60);
    const originalWeights = world.get(before, AnimationPlayer).unwrap().weights;
    const reloadedWeights = world.get(after, AnimationPlayer).unwrap().weights;
    expect(Array.from(reloadedWeights)).toEqual(Array.from(originalWeights));
    expect(originalWeights).toHaveLength(3);
    for (const [index, expected] of [0.5, 0.5, 0.3].entries()) {
      expect(originalWeights[index]).toBeCloseTo(expected, 6);
    }
  });
});
