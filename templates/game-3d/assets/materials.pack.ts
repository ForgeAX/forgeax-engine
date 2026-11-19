import { definePack, gpuTextureOutputs } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { ok } from '@forgeax/engine/types';
import { assetGuid, PACKAGE_IDS } from './shared/asset-refs.ts';

// One repeat contains four 2 m cells. Ground UVs span the 2000 m box once.
const tileSize = 2;
const repeats = 2000 / (2 * tileSize);

export default definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_IDS.materials,
  name: 'Game 3D / Materials',
  build: () =>
    ok({
      ...gpuTextureOutputs(PACKAGE_IDS.materials, 'paving', {
        values: { tileColor: [0.55, 0.52, 0.46, 1], tileContrast: 0.22 },
        inputs: {},
        transient: {},
        outputs: {
          albedo: {
            shape: { viewDimension: '2d', extent: { width: 512, height: 512 } },
            format: 'rgba8unorm-srgb',
            colorSpace: 'srgb',
            mips: { kind: 'generate' },
          },
        },
        passes: [{
          kind: 'raster',
          program: { module: 'game_3d::paving_texture', fragmentEntry: 'paving' },
          reads: {},
          writes: ['albedo'],
        }],
      }),
      'sampler/paving': {
        kind: 'sampler',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        maxAnisotropy: 16,
      },
      'material/standard-root': Materials.standard({
        baseColor: [1, 1, 1, 1],
        metallic: 0,
        roughness: 0.5,
      }),
      'material/ground': Materials.standard({
        baseColor: [1, 1, 1, 1],
        baseColorTexture: {
          texture: assetGuid(PACKAGE_IDS.materials, 'gpu-texture/paving/albedo'),
          sampler: assetGuid(PACKAGE_IDS.materials, 'sampler/paving'),
          coordinates: { transform: { scale: [repeats, repeats] } },
        },
        metallic: 0,
        roughness: 0.82,
      }),
      'material/rusted-iron': Materials.standard({
        surfaceModule: 'game_3d::rusted_iron_surface',
        parameters: [
          { name: 'ironColor', type: 'color' },
          { name: 'rustDark', type: 'color' },
          { name: 'rustBright', type: 'color' },
          { name: 'noiseScale', type: 'f32' },
        ],
        values: {
          ironColor: [0.4, 0.45, 0.47, 1],
          rustDark: [0.42, 0.085, 0.018, 1],
          rustBright: [0.95, 0.34, 0.055, 1],
          noiseScale: 1.85,
        },
      }),
    }),
});
