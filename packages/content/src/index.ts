import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  CONTENT_MESH_NAMES,
  CONTENT_PACKAGE_IDS,
  CONTENT_SOURCE_KEYS,
  type ContentMeshName,
  contentGuid,
} from './ids';

export {
  CONTENT_MESH_NAMES,
  CONTENT_PACKAGE_IDS,
  CONTENT_SOURCE_KEYS,
  type ContentMeshName,
  contentGuid,
} from './ids';

/** The forge.json `assetLibraries` specifier that mounts this library. */
export const ENGINE_CONTENT_LIBRARY = '@forgeax/engine/content';

function text(
  packageId: (typeof CONTENT_PACKAGE_IDS)[keyof typeof CONTENT_PACKAGE_IDS],
  key: string,
) {
  return AssetGuid.format(contentGuid(packageId, key));
}

/**
 * Stable GUID strings of every Engine Content asset. A project that lists
 * `@forgeax/engine/content` in forge.json `assetLibraries` can reference them
 * from Scenes, MeshRenderers and Materials like its own assets.
 */
export const EngineContent = Object.freeze({
  meshes: Object.freeze(
    Object.fromEntries(
      CONTENT_MESH_NAMES.map((name) => [
        name,
        text(CONTENT_PACKAGE_IDS.meshes, CONTENT_SOURCE_KEYS.mesh(name)),
      ]),
    ) as Record<ContentMeshName, string>,
  ),
  textures: Object.freeze({
    checker: text(CONTENT_PACKAGE_IDS.textures, CONTENT_SOURCE_KEYS.checkerTexture),
  }),
  samplers: Object.freeze({
    checker: text(CONTENT_PACKAGE_IDS.textures, CONTENT_SOURCE_KEYS.checkerSampler),
  }),
  materials: Object.freeze({
    default: text(CONTENT_PACKAGE_IDS.materials, CONTENT_SOURCE_KEYS.defaultMaterial),
  }),
});
