import { SceneCollectAssetGuidUnresolvedError } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { MeshFilter, MeshRenderer, SceneInstance } from '@forgeax/engine-render';
import { worldGetSceneAssetForInstance } from '@forgeax/engine-scene';
import type { AnimationClip, AssetHandle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { materialRecordFixture } from '../../../assets-runtime/src/__tests__/fixtures/material-publication';
import { loadMaterialFixture } from '../../../assets-runtime/src/__tests__/fixtures/runtime-material';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

const SCENE = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
const MESH = '00d274da-e863-41d8-bafe-10b97d1468d4';
const MATERIAL = '11111111-2222-4333-8444-555566667777';
const MATERIAL_B = '55555555-6666-4777-8888-99990000aaaa';
const CLIP = '44444444-5555-4666-8777-888899990000';
const CHILD = '22222222-3333-4444-8555-666677778888';
const bareScene: SceneAsset = {
  kind: 'scene',
  entities: { leaf: { components: { Transform: {} } } },
};

function fixture() {
  const world = new World();
  registerSceneComponents(world, [MeshFilter, MeshRenderer]);
  return { world, assets: testAssets(world) };
}

async function material(
  assets: ReturnType<typeof testAssets>,
  guid = MATERIAL,
  generation = 1,
  color: readonly number[] = [1, 1, 1, 1],
) {
  return (
    await loadMaterialFixture(
      assets,
      materialRecordFixture({
        guid,
        generation,
        parameters: [{ name: 'baseColor', type: 'color' }],
        values: { baseColor: color },
      }),
    )
  ).unwrap().handle;
}

function firstMaterial(world: World, root: EntityHandle) {
  for (const entity of world.iterDescendants(root)) {
    const value = world.get(entity, MeshRenderer);
    if (value.ok && value.value.materials[0])
      return value.value.materials[0] as AssetHandle<'material'>;
  }
  throw new Error('missing material holder');
}

describe('managed asset provenance during Scene collection', () => {
  it('retains the loaded Scene source identity after instantiation', async () => {
    const { world, assets } = fixture();
    try {
      publishTestAssets(assets, [{ guid: SCENE, kind: 'scene', payload: bareScene }]);
      const source = (await assets.load(SCENE, 'scene')).unwrap();
      const root = assets.instantiate(source, world).unwrap();
      const instanceSource = worldGetSceneAssetForInstance(world, root).unwrap();
      expect(instanceSource).toBe(source);
      expect(assets.guidOf(instanceSource)).toBe(SCENE);
      expect(assets.read(source).unwrap()).toEqual(bareScene);
    } finally {
      assets.dispose();
    }
  });

  it('keeps newly created content without source provenance', () => {
    const { assets } = fixture();
    try {
      const source = assets.create(bareScene).unwrap();
      expect(assets.guidOf(source)).toBeUndefined();
    } finally {
      assets.dispose();
    }
  });

  it('reports an unsourced Mesh through the complete structured collection error', () => {
    const { world, assets } = fixture();
    try {
      const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
      const scene = assets
        .create({
          kind: 'scene',
          entities: {
            leaf: {
              components: {
                Transform: {},
                MeshFilter: { assetHandle: mesh },
              },
            },
          },
        })
        .unwrap();
      const root = assets.instantiate(scene, world).unwrap();
      const result = rootsToSceneAsset(assets, world, [root]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(SceneCollectAssetGuidUnresolvedError);
      expect(result.error.code).toBe('scene-collect-asset-guid-unresolved');
      expect(result.error.expected.length).toBeGreaterThan(0);
      expect(result.error.hint.length).toBeGreaterThan(0);
      expect(result.error.detail).toMatchObject({ field: 'assetHandle', handle: mesh });
    } finally {
      assets.dispose();
    }
  });

  it('reloads a complete Mesh behind the same reference and preserves its save GUID', async () => {
    const { world, assets } = fixture();
    try {
      const initial = createBoxGeometry(1, 1, 1).unwrap();
      publishTestAssets(assets, [{ guid: MESH, kind: 'mesh', payload: initial }]);
      const mesh = (await assets.load(MESH, 'mesh')).unwrap();
      const old = assets.read(mesh).unwrap();
      const changed = {
        ...createBoxGeometry(3, 1, 1).unwrap(),
        materialSlots: [{ slotName: 'Recooked' }],
      };
      publishTestAssets(assets, [{ guid: MESH, kind: 'mesh', payload: changed }]);
      (await assets.reload(mesh, { conflict: 'reject' })).unwrap();
      const current = assets.read(mesh).unwrap();
      expect(current.materialSlots).toEqual([{ slotName: 'Recooked' }]);
      expect(current.attributes.position).toEqual(changed.attributes.position);
      expect(old.attributes.position).toEqual(initial.attributes.position);
      expect(current.attributes.position).not.toEqual(old.attributes.position);
      expect((await assets.load(MESH, 'mesh')).unwrap()).toBe(mesh);
      expect(assets.guidOf(mesh)).toBe(MESH);
      const scene = assets
        .create({
          kind: 'scene',
          entities: {
            leaf: {
              components: {
                Transform: {},
                MeshFilter: { assetHandle: mesh },
                MeshRenderer: { materials: [] },
              },
            },
          },
        })
        .unwrap();
      const root = assets.instantiate(scene, world).unwrap();
      const collected = rootsToSceneAsset(assets, world, [root]).unwrap();
      expect(collected.entities.leaf?.components.MeshFilter?.assetHandle).toBe(MESH);
    } finally {
      assets.dispose();
    }
  });

  it('shares one loaded Material reference through a nested Scene instance', async () => {
    const { world, assets } = fixture();
    try {
      const reference = await material(assets);
      publishTestAssets(assets, [{ guid: CHILD, kind: 'scene', payload: bareScene }]);
      const child = (await assets.load(CHILD, 'scene')).unwrap();
      const scene = assets
        .create({
          kind: 'scene',
          entities: {
            child: {
              components: {},
              instance: {
                source: child,
                overrides: [
                  { target: ['leaf'], components: { MeshRenderer: { materials: [reference] } } },
                ],
              },
            },
          },
        })
        .unwrap();
      const root = assets.instantiate(scene, world).unwrap();
      expect(
        [...world.iterDescendants(root)].some((entity) => world.get(entity, SceneInstance).ok),
      ).toBe(true);
      expect(firstMaterial(world, root)).toBe(reference);
      expect(assets.guidOf(firstMaterial(world, root))).toBe(MATERIAL);
    } finally {
      assets.dispose();
    }
  });

  it('retains Material reference and source GUID across a source reload', async () => {
    const { assets } = fixture();
    try {
      const original = await material(assets);
      const detached = assets.read(original).unwrap();
      const reloaded = await material(assets, MATERIAL, 2, [0.2, 0.3, 0.4, 1]);
      expect(reloaded).toBe(original);
      expect(assets.guidOf(original)).toBe(MATERIAL);
      expect(assets.read(original).unwrap().values?.baseColor).toEqual([0.2, 0.3, 0.4, 1]);
      expect(detached.values?.baseColor).toEqual([1, 1, 1, 1]);
    } finally {
      assets.dispose();
    }
  });

  it('retains AnimationClip reference and source GUID across a source reload', async () => {
    const { assets } = fixture();
    try {
      const clip: AnimationClip = { kind: 'animation-clip', duration: 1.5, channels: [] };
      publishTestAssets(assets, [{ guid: CLIP, kind: 'animation-clip', payload: clip }]);
      const reference = (await assets.load(CLIP, 'animation-clip')).unwrap();
      publishTestAssets(assets, [
        { guid: CLIP, kind: 'animation-clip', payload: { ...clip, duration: 3 } },
      ]);
      (await assets.reload(reference, { conflict: 'reject' })).unwrap();
      expect((await assets.load(CLIP, 'animation-clip')).unwrap()).toBe(reference);
      expect(assets.guidOf(reference)).toBe(CLIP);
      expect(assets.read(reference).unwrap().duration).toBe(3);
    } finally {
      assets.dispose();
    }
  });

  it('keeps a shared Material GUID distinct from another source across many holders', async () => {
    const { world, assets } = fixture();
    try {
      const a = await material(assets);
      const b = await material(assets, MATERIAL_B);
      const holders = [a, a, b].map((reference) =>
        world
          .spawn({
            component: MeshRenderer,
            data: { materials: [reference] },
          })
          .unwrap(),
      );
      expect(await material(assets, MATERIAL, 2)).toBe(a);
      expect(await material(assets, MATERIAL_B, 2)).toBe(b);
      const collected = rootsToSceneAsset(assets, world, holders).unwrap();
      expect(
        Object.values(collected.entities).map(
          (entity) => entity.components.MeshRenderer?.materials,
        ),
      ).toEqual([[MATERIAL], [MATERIAL], [MATERIAL_B]]);
    } finally {
      assets.dispose();
    }
  });

  it('treats an edited copy as a new unsourced asset and refuses silent GUID substitution', async () => {
    const { world, assets } = fixture();
    try {
      const original = await material(assets);
      const copy = assets.copy(original).unwrap();
      assets.update(copy, { values: { baseColor: [0.2, 0.2, 0.2, 1] } }).unwrap();
      expect(assets.guidOf(copy)).toBeUndefined();
      expect(assets.guidOf(original)).toBe(MATERIAL);
      expect(assets.read(original).unwrap().values?.baseColor).toEqual([1, 1, 1, 1]);
      const holder = world.spawn({ component: MeshRenderer, data: { materials: [copy] } }).unwrap();
      const result = rootsToSceneAsset(assets, world, [holder]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SceneCollectAssetGuidUnresolvedError);
        expect(result.error.code).toBe('scene-collect-asset-guid-unresolved');
      }
    } finally {
      assets.dispose();
    }
  });
});
