import { definePack } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import type { MaterialAsset } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { PACKAGE_IDS } from './shared/asset-refs.ts';

function skinned(material: MaterialAsset): MaterialAsset {
  if (material.passes === undefined) return material;
  const [first, ...rest] = material.passes;
  const withSkinProgram = (pass: (typeof material.passes)[number]) =>
    pass.name === 'shadow-caster'
      ? pass
      : {
          ...pass,
          program: { ...pass.program, module: 'forgeax::pbr-skin' },
        };
  return {
    ...material,
    passes: [withSkinProgram(first), ...rest.map(withSkinProgram)],
  };
}

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
      'material/metal': Materials.standard({ staticSwitches: { clearcoat: true },
        baseColor: [0.86, 0.9, 0.96, 1],
        metallic: 0.98,
        roughness: 0.06,
        clearcoat: 0.35,
        clearcoatRoughness: 0.04,
      }),
      'material/white': Materials.standard({
        baseColor: [0.72, 0.61, 0.48, 1],
        metallic: 0,
        roughness: 0.62,
      }),
      'material/light': Materials.standard({
        baseColor: [1, 0.46, 0.12, 1],
        emissive: [1, 0.14, 0.018],
        emissiveIntensity: 5,
        metallic: 0,
        roughness: 0.2,
      }),
      'material/player-body': skinned(
        Materials.standard({ baseColor: [0.72, 0.78, 0.73, 1], metallic: 0.22, roughness: 0.36 }),
      ),
      'material/player-accent': skinned(
        Materials.standard({
          baseColor: [0.018, 0.027, 0.033, 1],
          metallic: 0.5,
          roughness: 0.48,
        }),
      ),
      'material/player-signal': skinned(
        Materials.standard({ baseColor: [1, 0.36, 0.035, 1], metallic: 0.5, roughness: 0.27 }),
      ),
      'material/fantasy-azure': Materials.standard({ staticSwitches: { clearcoat: true },
        baseColor: [0.025, 0.48, 0.82, 1],
        emissive: [0.01, 0.18, 0.42],
        emissiveIntensity: 1.4,
        metallic: 0.42,
        roughness: 0.2,
        clearcoat: 0.65,
        clearcoatRoughness: 0.12,
      }),
      'material/fantasy-violet': Materials.standard({ staticSwitches: { clearcoat: true },
        baseColor: [0.34, 0.045, 0.72, 1],
        emissive: [0.16, 0.01, 0.38],
        emissiveIntensity: 1.7,
        metallic: 0.26,
        roughness: 0.24,
        clearcoat: 0.5,
        clearcoatRoughness: 0.16,
      }),
      'material/fantasy-gold': Materials.standard({ staticSwitches: { clearcoat: true },
        baseColor: [0.95, 0.48, 0.055, 1],
        emissive: [0.72, 0.16, 0.012],
        emissiveIntensity: 2.2,
        metallic: 0.78,
        roughness: 0.18,
        clearcoat: 0.3,
        clearcoatRoughness: 0.2,
      }),
      'material/obstacle': Materials.standard({
        baseColor: [0.42, 0.23, 0.11, 1],
        metallic: 0.04,
        roughness: 0.72,
      }),
      'material/player-cloth': skinned(
        Materials.standard({ staticSwitches: { clearcoat: true },
          baseColor: [0.025, 0.145, 0.17, 1],
          metallic: 0.4,
          roughness: 0.38,
          clearcoat: 0.04,
          clearcoatRoughness: 0.48,
        }),
      ),
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
