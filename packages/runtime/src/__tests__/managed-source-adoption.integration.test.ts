import { animationClipContribution, animationGraphContribution } from '@forgeax/engine-animation';
import {
  AssetRegistry,
  createCatalogSource,
  retainAssetPublications,
} from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { materialContribution, samplerContribution } from '@forgeax/engine-render';
import {
  ChildOf,
  Children,
  sceneAssetContribution,
  sceneEntityAddressKey,
  worldGetSceneInstanceState,
} from '@forgeax/engine-scene';
import type {
  AnimationClip,
  AssetDecoderContributionRef,
  AssetKind,
  CatalogEntry,
  MaterialAsset,
} from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const Value = defineComponent('ManagedSourceValue', { material: 'asset<material>', amount: 'f32' });
const Instance = defineComponent('SceneInstance', {
  source: 'asset<scene>',
  mapping: 'array<entity>',
  state: 'unique<SceneInstanceState>',
});

it('prepares and retains publications with the same installed decoder as normal runtime loads', async () => {
  const decode = vi.fn(samplerContribution.decoder.decode);
  const contribution = {
    ...samplerContribution,
    decoder: { ...samplerContribution.decoder, decode },
  };
  const { registry, publication, rows } = setup(
    [
      {
        guid: A,
        kind: 'sampler',
        refs: [],
        payload: { kind: 'sampler', magFilter: 'linear', minFilter: 'linear' },
      },
    ],
    [contribution] as readonly AssetDecoderContributionRef[],
  );
  const fetcher = async () => Response.json(publication.pack);
  try {
    const prepared = (
      await registry.preparePublication(rows, fetcher, undefined, { pack: publication.pack })
    ).unwrap();
    expect(prepared.size).toBe(1);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(runtimeAssets(registry).inspect().assets).toBe(0);
    const loaded = (await registry.load(A, 'sampler')).unwrap();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(registry.read(loaded).unwrap()).toMatchObject({ kind: 'sampler', magFilter: 'linear' });
    const digest = publication.publication.outputs[0]?.digest;
    if (digest === undefined) throw new Error('missing output digest');
    const retained = await retainAssetPublications(
      registry,
      new Map([[A, digest]]),
      rows,
      createCatalogSource({
        entries: rows,
        expectedScope: { scopeId: 'managed-source', generation: 1 },
      }),
      fetcher,
    );
    const data = retained.get(A)?.asset;
    if (typeof data !== 'function') throw new Error('expected lazy retained domain read');
    expect(await data()).toMatchObject({ kind: 'sampler', magFilter: 'linear' });
    expect(decode).toHaveBeenCalledTimes(3);
  } finally {
    registry.dispose();
  }
});

function setup(
  assets: { guid: string; kind: string; payload: Record<string, unknown>; refs: string[] }[],
  contributions: readonly AssetDecoderContributionRef[],
) {
  const packageUrl = 'https://managed.invalid/pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'managed-source',
    sourcePath: 'fixture.pack',
    sourceRevision: '1',
    packageUrl,
    pack: { assets: assets.map((asset) => ({ ...asset, artifacts: {} })) },
  });
  const rows: CatalogEntry[] = assets.map((asset) => ({
    guid: asset.guid,
    kind: asset.kind,
    packageUrl,
    sourcePath: 'fixture.pack',
    publication: publication.publication,
    lifecycle: 'current',
  }));
  const registry = new AssetRegistry({
    catalog: createCatalogSource({
      entries: rows,
      expectedScope: { scopeId: 'managed-source', generation: 1 },
    }),
    fetcher: async () => Response.json(publication.pack),
    components: new Map([[Value.name, Value]]),
  });
  for (const contribution of contributions)
    registry.installDecoder(contribution.kind as AssetKind<unknown>, contribution.decoder);
  return { registry, publication, rows };
}

it('decodes, flattens and binds a source material through the native publication path', async () => {
  const { registry } = setup(
    [
      {
        guid: A,
        kind: 'material',
        refs: [],
        payload: {
          kind: 'material',
          passes: [{ name: 'forward', program: { module: 'forgeax::default-unlit' } }],
          parameters: [
            { name: 'roughness', type: 'f32' },
            { name: 'metallic', type: 'f32' },
          ],
          values: { roughness: 1, metallic: 0.5 },
        },
      },
      {
        guid: B,
        kind: 'material',
        refs: [A],
        payload: { kind: 'material', parent: 0, values: { roughness: 0.2 } },
      },
      {
        guid: C,
        kind: 'scene',
        refs: [B],
        payload: {
          kind: 'scene',
          entities: { object: { components: { ManagedSourceValue: { material: 0, amount: 7 } } } },
        },
      },
    ],
    [materialContribution, sceneAssetContribution] as readonly AssetDecoderContributionRef[],
  );
  const world = new World({ assets: registry });
  for (const token of [Value, Instance, ChildOf, Children])
    world.components.register(token).unwrap();
  try {
    const scene = (await registry.load(C, 'scene')).unwrap();
    const material = (await registry.load(B, 'material')).unwrap();
    expect(registry.read(material).unwrap()).toMatchObject({
      values: { roughness: 0.2, metallic: 0.5 },
    });
    expect(registry.read(material).unwrap().parent).toBeUndefined();
    const fixed = registry.snapshot(scene).unwrap();
    expect(fixed.read<MaterialAsset>(material).unwrap().values?.roughness).toBe(0.2);
    registry.update(material, { values: { roughness: 0.6 } }).unwrap();
    const root = registry.instantiate(scene, world).unwrap();
    const member = worldGetSceneInstanceState(world, root)
      .unwrap()
      .bindings.get(sceneEntityAddressKey('object'));
    if (member === undefined) throw new Error('missing scene member');
    expect(world.get(member, Value).unwrap()).toMatchObject({ material, amount: 7 });
    expect(registry.read(material).unwrap().values?.roughness).toBe(0.6);
    expect(fixed.matchesCurrent()).toBe(false);
    fixed.dispose();
  } finally {
    registry.dispose();
  }
});

it('links decoded graph clips and retains outer publication dependencies in the same fixed closure', async () => {
  const { registry } = setup(
    [
      {
        guid: A,
        kind: 'animation-clip',
        refs: [],
        payload: { kind: 'animation-clip', channels: [], duration: 1 },
      },
      { guid: B, kind: 'sampler', refs: [], payload: { kind: 'sampler' } },
      {
        guid: C,
        kind: 'animation-graph',
        refs: [A, B],
        payload: {
          kind: 'animation-graph',
          root: 0,
          nodes: [{ type: 'clip', clip: 0, weight: 1 }],
        },
      },
    ],
    [
      animationClipContribution,
      animationGraphContribution,
      samplerContribution,
    ] as readonly AssetDecoderContributionRef[],
  );
  try {
    const graph = (await registry.load(C, 'animation-graph')).unwrap();
    const clip = (await registry.load(A, 'animation-clip')).unwrap();
    const sampler = (await registry.load(B, 'sampler')).unwrap();
    expect(registry.read(graph).unwrap().nodes[0]).toMatchObject({ clip });
    const fixed = registry.snapshot(graph).unwrap();
    expect(fixed.read(sampler).unwrap()).toMatchObject({ kind: 'sampler' });
    const revision = runtimeAssets(registry).version(graph).unwrap();
    registry.update(clip, { duration: 2 }).unwrap();
    expect(runtimeAssets(registry).version(graph).unwrap()).toBe(revision);
    expect(fixed.read<AnimationClip>(clip).unwrap().duration).toBe(1);
    expect(fixed.matchesCurrent()).toBe(false);
    fixed.dispose();
  } finally {
    registry.dispose();
  }
});
