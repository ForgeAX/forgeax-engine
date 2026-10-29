import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { AssetGuid as AssetGuidBytes } from '@forgeax/engine-types';

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

export const CONTENT_SOURCE_KEYS = Object.freeze({
  mesh: (name: ContentMeshName) => `mesh/${name}`,
  checkerTexture: 'texture/checker',
  checkerSampler: 'sampler/checker',
  defaultMaterial: 'material/default',
});

export function contentGuid(packageIdValue: PackageId, sourceKey: string): AssetGuidBytes {
  return AssetGuid.derive(packageIdValue, sourceKey) as AssetGuidBytes;
}
