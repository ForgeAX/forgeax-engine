import { type MaterialAsset, standardSurfaceParameters, withClipping } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker';

it('cooks public clipping through real Standard color, shadow, temporal and scene-index programs', async () => {
  const root: MaterialAsset = {
    kind: 'material',
    parameters: standardSurfaceParameters([]),
    passes: [
      {
        name: 'forward',
        program: {
          module: 'forgeax_material::standard',
          moduleSlots: { surface: 'forgeax_material::default_standard_surface' },
        },
      },
      {
        name: 'shadow-caster',
        program: {
          module: 'forgeax::default-shadow-caster',
          moduleSlots: { surface: 'forgeax_material::default_standard_surface' },
        },
      },
    ],
  };
  const cooked = await createMaterialPackCooker().cook({
    guid: 'clipping-standard',
    source: withClipping(root, { planes: [[1, 0, 0, 0]], clipShadows: true }),
  });
  const artifacts = Object.values(cooked.artifacts);
  expect(artifacts.length).toBeGreaterThan(0);
  const text = artifacts.map((a) => new TextDecoder().decode(a.bytes)).join('\n');
  expect(text).toContain('clippingPlaneA');
  expect(text).toContain('clippedByPlanes');
}, 120_000);

it('cooks the same local policy for Unlit without moving texture coordinates into clipping lanes', async () => {
  const cooked = await createMaterialPackCooker().cook({
    guid: 'clipping-unlit',
    source: withClipping(
      {
        kind: 'material',
        parameters: [
          { name: 'baseColor', type: 'color' },
          { name: 'alphaCutoff', type: 'f32' },
          { name: 'alphaHash', type: 'f32', default: 0 },
          { name: 'shading', type: 'f32', default: 0 },
          { name: 'baseColorTexture', type: 'texture' },
        ],
        passes: [
          { name: 'forward', program: { module: 'forgeax_material::unlit' } },
          { name: 'shadow', program: { module: 'forgeax_material::unlit' } },
        ],
      },
      { planes: [[1, 0, 0, 0]] },
    ),
  });
  expect(Object.keys(cooked.artifacts).length).toBeGreaterThan(0);
}, 120_000);
