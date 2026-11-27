import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { Disabled, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import { prepareExtractContext, prepareMeshSourceSteps } from '@forgeax/engine-render/internal';
import { Transform } from '@forgeax/engine-scene';
import { prepareSceneTransformsSteps } from '@forgeax/engine-scene/internal';
import { ShaderRegistry } from '@forgeax/engine-shader';

function complete<T>(iterator: Generator<void, T>): T {
  for (let next = iterator.next(); ; next = iterator.next()) if (next.done) return next.value;
}

export function closedLevelWorld() {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const previousMesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const coldMesh = assets.create(createBoxGeometry(2, 1, 1).unwrap()).unwrap();
  const texture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: Uint8Array.of(100, 120, 140, 255),
    })
    .unwrap();
  const material = assets
    .create(
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        emissive: [1, 0.02, 0.01],
        emissiveIntensity: 4,
        baseColorTexture: { texture },
      }),
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 10] } },
      { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1 }) },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { castShadow: true, direction: [0.2, -1, 0.3], mapSize: 2048, cascadeCount: 3 },
    })
    .unwrap();
  const resident = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: previousMesh } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  const members = [-2, 3].map((x) =>
    world
      .spawn(
        { component: Disabled, data: {} },
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: coldMesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap(),
  );
  world.update(1 / 60).unwrap();
  const roster = {
    members,
    authorDisabled: new Set<typeof resident>(),
    isCurrent: () => members.every((entity) => world.hasComponent(entity, Disabled)),
  };
  complete(prepareSceneTransformsSteps(world, roster)).unwrap();
  const rows = complete(
    prepareMeshSourceSteps(
      world,
      prepareExtractContext(world, { assets, cull: 'none', retainHidden: true }),
      roster,
    ),
  ).unwrap();
  const coldAsset = {
    handle: coldMesh,
    revision: runtimeAssets(assets).version(coldMesh).unwrap(),
    value: assets.read(coldMesh).unwrap(),
  };
  const coldAssets = [
    coldAsset,
    ...[material, texture].map((handle) => ({
      handle,
      revision: runtimeAssets(assets).version(handle).unwrap(),
      value: assets.read(handle).unwrap(),
    })),
  ];
  return {
    assets,
    world,
    camera,
    resident,
    members,
    rows,
    coldMesh,
    coldAsset,
    coldAssets,
    texture,
    material,
  };
}
