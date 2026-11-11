import { definePack } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { ok } from '@forgeax/engine/types';
import { PACKAGE_IDS } from './shared/asset-refs.ts';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_IDS.materials,
  name: 'Game 3D / Materials',
  build: () =>
    ok({
      'material/standard-root': Materials.standard({
        baseColor: [1, 1, 1, 1],
        metallic: 0,
        roughness: 0.5,
      }),
      'material/ground': Materials.standard({
        baseColor: [0.055, 0.075, 0.07, 1],
        metallic: 0.06,
        roughness: 0.82,
      }),
      'material/painted': Materials.standard({ staticSwitches: { clearcoat: true },
        baseColor: [0.28, 0.035, 0.075, 1],
        metallic: 0.12,
        roughness: 0.18,
        clearcoat: 0.82,
        clearcoatRoughness: 0.08,
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
