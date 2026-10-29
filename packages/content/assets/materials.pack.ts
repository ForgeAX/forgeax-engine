import { definePack } from '@forgeax/engine-pack/source';
import { Materials } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { CONTENT_PACKAGE_IDS, CONTENT_SOURCE_KEYS, contentGuid } from '../src/ids.ts';

/** Checker tiles per UV unit; a unit mesh face shows eight cells per side. */
export const DEFAULT_MATERIAL_UV_SCALE = 4;

export default definePack({
  schemaVersion: '2.0.0',
  packageId: CONTENT_PACKAGE_IDS.materials,
  name: 'Engine Content / Materials',
  build: () =>
    ok({
      [CONTENT_SOURCE_KEYS.defaultMaterial]: Materials.standard({
        baseColor: [1, 1, 1, 1],
        metallic: 0,
        roughness: 0.7,
        baseColorTexture: {
          texture: contentGuid(CONTENT_PACKAGE_IDS.textures, CONTENT_SOURCE_KEYS.checkerTexture),
          sampler: contentGuid(CONTENT_PACKAGE_IDS.textures, CONTENT_SOURCE_KEYS.checkerSampler),
          coordinates: {
            transform: { scale: [DEFAULT_MATERIAL_UV_SCALE, DEFAULT_MATERIAL_UV_SCALE] },
          },
        },
      }),
    }),
});
