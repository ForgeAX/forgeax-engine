import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker';

it.each([
  'forgeax_material::standard',
  'forgeax::pbr-skin',
])('cooks optional flat normals with clearcoat through every %s pass', async (module) => {
  expect(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.some((field) => field.name === 'flatShading')).toBe(
    false,
  );
  expect(standardSurfaceParameters([]).some((field) => field.name === 'flatShading')).toBe(false);
  const source: MaterialAsset = {
    kind: 'material',
    parameters: standardSurfaceParameters([
      { name: 'flatShading', type: 'u32', default: 0 },
      { name: 'clearcoat', type: 'f32', default: 1 },
      { name: 'clearcoatRoughness', type: 'f32', default: 0.1 },
      { name: 'clearcoatNormalScale', type: 'f32', default: 1 },
    ]),
    passes: [{ name: 'forward', program: { module } }],
    values: { flatShading: 1 },
  };
  const cooked = await createMaterialPackCooker().cook({ guid: 'standard-flat', source });
  expect(Object.keys(cooked.artifacts).length).toBeGreaterThan(0);
}, 120_000);
