import {
  animationClipContribution,
  animationGraphContribution,
  defineAnimationGraph,
  serializeAnimationGraph,
} from '@forgeax/engine-animation';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import {
  createRuntimePackPublication,
  type RuntimePackAssetInput,
} from '@forgeax/engine-pack/runtime';
import { expect, it } from 'vitest';

const CLIPS = [
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000003',
] as const;
const GRAPH = 'a1000000-0000-4000-8000-000000000004';

function registry() {
  const assets = new AssetRegistry();
  assets.installDecoder(animationClipContribution.kind, animationClipContribution.decoder);
  assets.installDecoder(animationGraphContribution.kind, animationGraphContribution.decoder);
  return assets;
}

function publish(
  assets: AssetRegistry,
  graph?: NonNullable<ReturnType<typeof serializeAnimationGraph>>,
) {
  const packageUrl = 'https://animation.invalid/graph.pack.json',
    sourcePath = 'graph.pack';
  const entries: RuntimePackAssetInput[] = CLIPS.map((guid, i) => ({
    guid,
    kind: 'animation-clip',
    refs: [],
    artifacts: {},
    payload: { kind: 'animation-clip', duration: 10 * (i + 1), channels: [] },
  }));
  if (graph !== undefined)
    entries.push({
      guid: GRAPH,
      kind: 'animation-graph',
      refs: graph.refs,
      artifacts: {},
      payload: { kind: 'animation-graph', ...graph.payload },
    });
  const produced = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath,
    sourceRevision: graph === undefined ? 'clips' : 'graph',
    packageUrl,
    pack: { assets: entries },
  });
  assets.setCatalogSource(
    createCatalogSource({
      entries: entries.map(({ guid, kind }) => ({
        guid,
        kind,
        sourcePath,
        packageUrl,
        publication: produced.publication,
      })),
      fetch: async () => Response.json(produced.pack),
    }),
  );
}

it('serializes shared managed clips into deduplicated source GUID indices', async () => {
  const assets = registry();
  try {
    publish(assets);
    const walk = (await assets.load(CLIPS[0], 'animation-clip')).unwrap();
    const run = (await assets.load(CLIPS[1], 'animation-clip')).unwrap();
    const graph = defineAnimationGraph((b) => {
      const base = b.blend([b.clip(walk), b.clip(run)]);
      return b.add(base, [b.clip(walk, 0.3)]);
    }).unwrap();
    const serialized = serializeAnimationGraph(graph, (clip) =>
      typeof clip === 'string' ? clip : assets.guidOf(clip),
    );
    expect(serialized?.refs).toEqual([CLIPS[0], CLIPS[1]]);
    expect(serialized?.payload.nodes).toEqual([
      { type: 'clip', clip: 0, weight: 1 },
      { type: 'clip', clip: 1, weight: 1 },
      { type: 'blend', children: [0, 1], weight: 1 },
      { type: 'clip', clip: 0, weight: 0.3 },
      { type: 'add', base: 2, additive: [3], weight: 1 },
    ]);
  } finally {
    assets.dispose();
  }
});

it('loads a serialized nested graph through Pack JSON with identical topology, weights and managed clips', async () => {
  const assets = registry();
  try {
    publish(assets);
    const walk = (await assets.load(CLIPS[0], 'animation-clip')).unwrap();
    const run = (await assets.load(CLIPS[1], 'animation-clip')).unwrap();
    const survey = (await assets.load(CLIPS[2], 'animation-clip')).unwrap();
    const original = defineAnimationGraph((b) => {
      const w = b.clip(walk),
        r = b.clip(run),
        s = b.clip(survey, 0.5);
      const locomotion = b.blend([w, r]);
      const base = b.blend([s, locomotion], 0.8);
      return b.add(base, [b.clip(survey, 0.3)]);
    }).unwrap();
    const serialized = serializeAnimationGraph(original, (clip) =>
      typeof clip === 'string' ? clip : assets.guidOf(clip),
    );
    if (serialized === undefined) throw new Error('graph serialization lost a loaded clip GUID');
    publish(assets, serialized);
    const graph = (await assets.load(GRAPH, 'animation-graph')).unwrap();
    expect(assets.read(graph).unwrap()).toEqual(original);
  } finally {
    assets.dispose();
  }
});

it('rejects a malformed graph reference index before publishing any asset', async () => {
  const assets = registry();
  try {
    publish(assets, {
      payload: { nodes: [{ type: 'clip', clip: 5, weight: 1 }], root: 0 },
      refs: [CLIPS[0]],
    });
    expect(await assets.load(GRAPH, 'animation-graph')).toMatchObject({
      ok: false,
      error: { code: 'asset-package-invalid' },
    });
    expect(assets.inspect().assets).toHaveLength(0);
  } finally {
    assets.dispose();
  }
});
