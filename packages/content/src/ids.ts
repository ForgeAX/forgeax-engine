import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { AssetGuid as AssetGuidBytes } from '@forgeax/engine-types';
import { WATER_MATERIAL_FAMILY_KEYS, type WaterMaterialFamilyKey } from '@forgeax/engine-water';

function packageId(text: string): PackageId {
  const parsed = PackageId.parse(text);
  if (!parsed.ok) throw new TypeError(`Engine Content package id is invalid: ${text}`);
  return parsed.value;
}

/** Fixed Pack namespaces of the Engine Content library; GUIDs derive from these and source keys. */
export const CONTENT_PACKAGE_IDS = Object.freeze({
  meshes: packageId('019fc0e7-1000-7000-8000-000000000001'),
  textures: packageId('019fc0e7-1000-7000-8000-000000000002'),
  materials: packageId('019fc0e7-1000-7000-8000-000000000003'),
  water: packageId('019fc0e7-1000-7000-8000-000000000004'),
  waterVolume: packageId('019fc0e7-1000-7000-8000-000000000005'),
  waterImpulse: packageId('019fc0e7-1000-7000-8000-000000000006'),
});

/** Unit primitives, each fitting the [-0.5, 0.5] cube unless its name says otherwise. */
export const CONTENT_MESH_NAMES = [
  'cube',
  'sphere',
  'cylinder',
  'cone',
  'torus',
  'capsule',
  'plane',
  'quad',
  'nine-slice-quad',
  'triangle',
] as const;

export type ContentMeshName = (typeof CONTENT_MESH_NAMES)[number];
export const CONTENT_WATER_MATERIAL_NAMES = WATER_MATERIAL_FAMILY_KEYS;
export const CONTENT_WATER_TEXTURE_NAMES = [
  'normal',
  'river-diffuse',
  'river-normal',
  'foam',
  'foam-normal',
  'noise',
  'volume-noise',
  'impulse-noise',
] as const;
export type ContentWaterTextureName = (typeof CONTENT_WATER_TEXTURE_NAMES)[number];

export const CONTENT_SOURCE_KEYS = Object.freeze({
  mesh: (name: ContentMeshName) => `mesh/${name}`,
  checkerTexture: 'texture/checker',
  checkerSampler: 'sampler/checker',
  defaultMaterial: 'material/default',
  waterMaterial: (name: WaterMaterialFamilyKey) => `material/water/${name}`,
  waterTexture: (name: ContentWaterTextureName) => `texture/water/${name}`,
  waterVolumeNoiseAtlas: 'texture/water/volume-noise-atlas',
  waterImpulseNoiseSource: 'texture/water/impulse-noise-source',
  waterSampler: 'sampler/water-repeat',
});

export function contentGuid(packageIdValue: PackageId, sourceKey: string): AssetGuidBytes {
  return AssetGuid.derive(packageIdValue, sourceKey) as AssetGuidBytes;
}

export function contentWaterTextureGuid(name: ContentWaterTextureName): AssetGuidBytes {
  return contentGuid(
    name === 'volume-noise'
      ? CONTENT_PACKAGE_IDS.waterVolume
      : name === 'impulse-noise'
        ? CONTENT_PACKAGE_IDS.waterImpulse
        : CONTENT_PACKAGE_IDS.textures,
    CONTENT_SOURCE_KEYS.waterTexture(name),
  );
}
