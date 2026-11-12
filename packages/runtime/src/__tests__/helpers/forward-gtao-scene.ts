import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
  PointLight,
  Skylight,
  TONEMAP_LINEAR,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { boxSceneField } from '../../../../render/src/__tests__/gtao-reference';
import { testAssets } from './runtime-assets';
import {
  attachStandardPbrSkin,
  standardPbrSkinMaterial,
  standardPbrSkinMesh,
} from './standard-pbr-skin-subject';

export const FORWARD_GTAO_FIXTURE = Object.freeze({
  id: 'forward-gtao-box-contact-normal-alpha-mask-v4',
  width: 129,
  height: 97,
  radius: 1.25,
  bias: 0,
  intensity: 4,
  thickness: 1,
  distanceExponent: 1,
  distanceFallOff: 1,
  resolutionScale: 0.5,
  quality: 'high' as const,
  temporalJitter: false,
  // Keep the half-alpha boundary off odd-width pixel centers on every backend.
  alphaMask: { foregroundCenterX: 1 / 32, cutoff: 0.5, texel: [255, 255, 255, 255] as const },
});

/** Shared material-normal-capable production scene for Forward AO backend comparisons. */
export function createForwardGtaoScene(world: World, width = 128, height = 128) {
  const assets = testAssets(world);
  const normalTexture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([191, 159, 234, 255]),
    } satisfies TextureAsset)
    .unwrap();
  const alphaTexture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array(FORWARD_GTAO_FIXTURE.alphaMask.texel),
    } satisfies TextureAsset)
    .unwrap();
  const material = assets
    .create(
      Materials.standard({
        baseColor: [0.5, 0.5, 0.5, 1],
        emissive: [0.08, 0.03, 0.015],
        metallic: 0,
        roughness: 1,
        // Environment specular takes its own (specular) occlusion, which the
        // CPU reference does not model; a purely diffuse receiver keeps the
        // linear-lighting comparison exact.
        specular: 0,
        normalTexture: { texture: normalTexture },
        normalScale: [1, 1],
        alphaTexture: { texture: alphaTexture },
        alphaCutoff: FORWARD_GTAO_FIXTURE.alphaMask.cutoff,
      }),
    )
    .unwrap();
  const boxDimensions: readonly (readonly [number, number, number, number])[] = [
    [20, 20, 0.01, -4.005],
    [1.4, 1.4, 0.2, -3.9],
  ];
  const surfaceEntities = [];
  for (const [width, height, depth, z] of boxDimensions) {
    const mesh = assets.create(createBoxGeometry(width, height, depth).unwrap()).unwrap();
    surfaceEntities.push(
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, z] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap(),
    );
  }
  const skylight = world.spawn({ component: Skylight, data: {} }).unwrap();
  const pointLight = world
    .spawn(
      { component: Transform, data: { pos: [0, 2, -2] } },
      { component: PointLight, data: { intensity: 8, range: 12 } },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: width / height,
          near: 0.1,
          far: 30,
          // This conformance workload has no TAA/temporal jitter. GTAO retains
          // its deterministic per-pixel spatial rotation.
          antialias: 0,
          bloom: 0,
          tonemap: TONEMAP_LINEAR,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  return {
    assets,
    camera,
    material,
    normalTexture,
    alphaTexture,
    skylight,
    pointLight,
    surfaceEntities,
  };
}

/** Independent ray-box reconstruction of the same immutable fixture geometry. */
export function createForwardGtaoReferenceField(width: number, height: number) {
  return boxSceneField({
    width,
    height,
    fovY: Math.PI / 3,
    near: 0.1,
    far: 30,
    normalTextureSample: [191 / 255, 159 / 255, 234 / 255],
    boxes: [
      { center: [0, 0, -4.005], size: [20, 20, 0.01] },
      { center: [0, 0, -3.9], size: [1.4, 1.4, 0.2] },
    ],
  });
}

/** Create two real Standard surfaces with a green-channel Alpha Mask and RG normal map. */
export function createForwardGtaoAlphaMaskScene(world: World) {
  const assets = testAssets(world);
  const alphaTexture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 2, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([255, 0, 255, 255, 255, 255, 255, 255]),
    } satisfies TextureAsset)
    .unwrap();
  const normalTexture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([250, 128, 0, 255]),
    } satisfies TextureAsset)
    .unwrap();
  const backgroundMaterial = assets
    .create(Materials.standard({ baseColor: [0.35, 0.55, 0.75, 1], roughness: 1, metallic: 0 }))
    .unwrap();
  const foregroundMaterial = assets
    .create(
      Materials.standard({
        baseColor: [0.8, 0.7, 0.5, 1],
        roughness: 1,
        metallic: 0,
        normalTexture: { texture: normalTexture },
        alphaTexture: { texture: alphaTexture },
        alphaChannel: 1,
        alphaCutoff: FORWARD_GTAO_FIXTURE.alphaMask.cutoff,
      }),
    )
    .unwrap();
  const backgroundMesh = assets.create(createBoxGeometry(20, 20, 0.1).unwrap()).unwrap();
  const foregroundMesh = assets.create(createBoxGeometry(4, 4, 0.1).unwrap()).unwrap();
  const background = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -6] } },
      { component: MeshFilter, data: { assetHandle: backgroundMesh } },
      { component: MeshRenderer, data: { materials: [backgroundMaterial] } },
    )
    .unwrap();
  const foreground = world
    .spawn(
      {
        component: Transform,
        data: { pos: [FORWARD_GTAO_FIXTURE.alphaMask.foregroundCenterX, 0, -4] },
      },
      { component: MeshFilter, data: { assetHandle: foregroundMesh } },
      { component: MeshRenderer, data: { materials: [foregroundMaterial] } },
    )
    .unwrap();
  return { assets, background, foreground, alphaTexture, normalTexture };
}

export function createForwardGtaoAlphaMaskReferenceField(width: number, height: number) {
  return boxSceneField({
    width,
    height,
    fovY: Math.PI / 3,
    near: 0.1,
    far: 30,
    boxes: [
      { center: [0, 0, -6], size: [20, 20, 0.1] },
      {
        center: [FORWARD_GTAO_FIXTURE.alphaMask.foregroundCenterX, 0, -4],
        size: [4, 4, 0.1],
        normalTextureSample: [250 / 255, 128 / 255, 0],
        alphaMask: {
          width: 2,
          height: 1,
          green: [0, 1],
          cutoff: FORWARD_GTAO_FIXTURE.alphaMask.cutoff,
        },
      },
    ],
  });
}

export function createForwardGtaoSkinReferenceField(
  width: number,
  height: number,
  jointWorldPosition: readonly [number, number, number],
) {
  return boxSceneField({
    width,
    height,
    fovY: Math.PI / 3,
    near: 0.1,
    far: 30,
    boxes: [
      { center: [0, 0, -6], size: [20, 20, 0.1] },
      {
        center: jointWorldPosition,
        size: [0.7, 1, 0.25],
        normalTextureSample: [191 / 255, 159 / 255, 234 / 255],
      },
    ],
  });
}

/** A second live camera exercises camera selection and orthographic Reverse-Z. */
export function createForwardGtaoOrthographicCamera(world: World) {
  return world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          ...orthographic({ left: -3, right: 3, bottom: -2.25, top: 2.25, near: 0.1, far: 30 }),
          tonemap: TONEMAP_LINEAR,
          antialias: 0,
          bloom: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
}

export function createForwardGtaoOrthographicReferenceField(width: number, height: number) {
  return createForwardGtaoOrthographicReferenceFieldWithBoxes(width, height);
}

export function createForwardGtaoOrthographicReferenceFieldWithBoxes(
  width: number,
  height: number,
  additionalBoxes: readonly {
    readonly center: readonly [number, number, number];
    readonly size: readonly [number, number, number];
  }[] = [],
) {
  return boxSceneField({
    width,
    height,
    fovY: 0,
    near: 0.1,
    far: 30,
    projection: {
      kind: 'orthographic',
      left: -3,
      right: 3,
      bottom: -2.25,
      top: 2.25,
    },
    normalTextureSample: [191 / 255, 159 / 255, 234 / 255],
    boxes: [
      { center: [0, 0, -4.005], size: [20, 20, 0.01] },
      { center: [0, 0, -3.9], size: [1.4, 1.4, 0.2] },
      ...additionalBoxes,
    ],
  });
}

/** Create the admitted pbr-skin program path with every vertex bound to one live joint. */
export function createForwardGtaoSkinSubject(
  world: World,
  assets: AssetRegistry,
  standardMaterial: ReturnType<typeof Materials.standard>,
  pose: readonly [number, number, number],
) {
  const source = createBoxGeometry(0.7, 1, 0.25).unwrap();
  const mesh = assets.create(standardPbrSkinMesh(source)).unwrap();
  const material = assets.create(standardPbrSkinMaterial(standardMaterial)).unwrap();
  const entity = world
    .spawn(
      // Skin palette positions are already world-space; this node stays at origin.
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const { joint, skeleton } = attachStandardPbrSkin(world, assets, entity, pose);
  return { entity, joint, material, mesh, skeleton };
}
