import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { runtimeAssetReference, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { type Component, defineComponent } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  createRuntimePackPublication,
  type RuntimePackAssetInput,
} from '@forgeax/engine-pack/runtime';
import { expect, it } from 'vitest';
import { installDefaultAssetDecoders } from '../asset-contributions';

const SCENE = '11111111-1111-4111-8111-111111111111';
const MESH = '22222222-2222-4222-8222-222222222222';
const MATERIAL = '33333333-3333-4333-8333-333333333333';
const TEXTURE = '44444444-4444-4444-8444-444444444444';
const SKIN = '55555555-5555-4555-8555-555555555555';
const SKELETON = '66666666-6666-4666-8666-666666666666';
const MeshBinding = defineComponent('AssetClosureMesh', { asset: 'asset<mesh>' });
const SkinBinding = defineComponent('AssetClosureSkin', { skeleton: 'asset<skeleton>' });

function registry() {
  const assets = new AssetRegistry({
    components: new Map<string, Component>([
      [MeshBinding.name, MeshBinding],
      [SkinBinding.name, SkinBinding],
    ]),
  });
  installDefaultAssetDecoders(assets);
  return assets;
}

function publish(assets: AssetRegistry, entries: readonly RuntimePackAssetInput[]) {
  const packageUrl = 'https://closure.invalid/scene.pack.json';
  const sourcePath = 'scene.pack';
  const produced = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath,
    sourceRevision: 'fixture',
    packageUrl,
    pack: { assets: [...entries] },
  });
  const body = JSON.stringify(produced.pack, (_key, value) =>
    ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
  );
  assets.setCatalogSource(
    createCatalogSource({
      entries: entries.map(({ guid, kind }) => ({
        guid,
        kind,
        sourcePath,
        packageUrl,
        publication: produced.publication,
      })),
      fetch: async () => new Response(body),
    }),
  );
}

const texture = {
  guid: TEXTURE,
  kind: 'texture',
  refs: [],
  artifacts: {},
  payload: {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: [255, 255, 255, 255],
  },
};

it.each([
  false,
  true,
])('rejects an unavailable or mistyped source Mesh default before publishing its identity (declared=%s)', async (declared) => {
  const assets = registry();
  try {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    publish(assets, [
      texture,
      {
        guid: MESH,
        kind: 'mesh',
        refs: declared ? [TEXTURE] : [],
        artifacts: {},
        payload: { ...mesh, materialSlots: [{ slotName: 'surface', defaultMaterial: TEXTURE }] },
      },
    ]);
    const result = await assets.load(MESH, 'mesh');
    expect(result.ok).toBe(false);
    expect(runtimeAssetReference(assets, MESH)).toBeUndefined();
    expect(runtimeAssets(assets).inspect().assets).toBe(0);
    publish(assets, [{ guid: MESH, kind: 'mesh', refs: [], artifacts: {}, payload: mesh }]);
    expect((await assets.load(MESH, 'mesh')).ok).toBe(true);
  } finally {
    assets.dispose();
  }
});

it.each([
  0,
  SKIN,
])('loads Scene skin references encoded as %s through the complete Skin/Skeleton closure', async (skinReference) => {
  const assets = registry();
  try {
    const inverseBindMatrices = new Float32Array(16);
    for (const index of [0, 5, 10, 15]) inverseBindMatrices[index] = 1;
    publish(assets, [
      {
        guid: SCENE,
        kind: 'scene',
        refs: [SKIN, SKELETON],
        artifacts: {},
        payload: {
          kind: 'scene',
          entities: { root: { components: { AssetClosureSkin: { skeleton: 1 } } } },
          skinGuids: [skinReference],
        },
      },
      {
        guid: SKIN,
        kind: 'skin',
        refs: [SKELETON],
        artifacts: {},
        payload: { kind: 'skin', skeletonGuid: SKELETON, jointPaths: ['root'] },
      },
      {
        guid: SKELETON,
        kind: 'skeleton',
        refs: [],
        artifacts: {},
        payload: { kind: 'skeleton', jointCount: 1, inverseBindMatrices },
      },
    ]);
    const scene = (await assets.load(SCENE, 'scene')).unwrap();
    const skin = (await assets.load(SKIN, 'skin')).unwrap();
    const skeleton = (await assets.load(SKELETON, 'skeleton')).unwrap();
    expect(assets.read(scene).unwrap().skinGuids).toEqual([SKIN]);
    expect(assets.read(skin).unwrap().skeletonGuid).toBe(SKELETON);
    expect(assets.read(skeleton).unwrap().inverseBindMatrices).toEqual(inverseBindMatrices);
    expect(runtimeAssets(assets).dependencies(scene).unwrap()).toEqual(
      expect.arrayContaining([skin, skeleton]),
    );
    expect(runtimeAssets(assets).dependencies(skin).unwrap()).toEqual([skeleton]);
    expect(
      assets
        .inspect()
        .assets.map(({ guid }) => guid)
        .sort(),
    ).toEqual([SCENE, SKIN, SKELETON]);
  } finally {
    assets.dispose();
  }
});

it('adopts the complete Scene/Mesh/Material/Texture closure and keeps scalar zero distinct from a texture reference', async () => {
  const assets = registry();
  try {
    publish(assets, [
      texture,
      {
        guid: MATERIAL,
        kind: 'material',
        refs: [TEXTURE],
        artifacts: {},
        payload: {
          kind: 'material',
          passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
          parameters: [
            { name: 'roughness', type: 'f32' },
            { name: 'albedo', type: 'texture' },
          ],
          values: { roughness: 0, albedo: { texture: 0 } },
        },
      },
      {
        guid: MESH,
        kind: 'mesh',
        refs: [MATERIAL],
        artifacts: {},
        payload: {
          ...createBoxGeometry(1, 1, 1).unwrap(),
          materialSlots: [{ slotName: 'surface', defaultMaterial: MATERIAL }],
        },
      },
      {
        guid: SCENE,
        kind: 'scene',
        refs: [MESH],
        artifacts: {},
        payload: {
          kind: 'scene',
          entities: { root: { components: { AssetClosureMesh: { asset: 0 } } } },
        },
      },
    ]);
    const scene = (await assets.load(SCENE, 'scene')).unwrap();
    const mesh = (await assets.load(MESH, 'mesh')).unwrap();
    const material = (await assets.load(MATERIAL, 'material')).unwrap();
    const image = (await assets.load(TEXTURE, 'texture')).unwrap();
    expect(assets.read(material).unwrap().values).toMatchObject({
      roughness: 0,
      albedo: { texture: image },
    });
    expect(assets.read(mesh).unwrap().materialSlots[0]?.defaultMaterial).toBe(material);
    expect(runtimeAssets(assets).dependencies(scene).unwrap()).toEqual([mesh]);
    expect(runtimeAssets(assets).dependencies(mesh).unwrap()).toEqual([material]);
    expect(runtimeAssets(assets).dependencies(material).unwrap()).toEqual([image]);
    expect(
      assets
        .inspect()
        .assets.map(({ guid }) => guid)
        .sort(),
    ).toEqual([SCENE, MESH, MATERIAL, TEXTURE]);
  } finally {
    assets.dispose();
  }
});
