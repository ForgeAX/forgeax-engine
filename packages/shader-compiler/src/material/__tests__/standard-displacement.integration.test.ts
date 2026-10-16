import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker';

it.each([
  'forgeax_material::standard',
  'forgeax::pbr-skin',
])('cooks displaced %s color, depth, shadow and GPU scene programs from one contract', async (module) => {
  const source: MaterialAsset = {
    kind: 'material',
    parameters: standardSurfaceParameters([{ name: 'displacementTexture', type: 'texture' }]),
    passes: [
      {
        name: 'forward',
        program: { module, moduleSlots: { surface: 'forgeax_material::default_standard_surface' } },
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
  const cooked = await createMaterialPackCooker().cook({ guid: 'standard-displacement', source });
  const artifacts = Object.values(cooked.artifacts);
  expect(artifacts.length).toBeGreaterThan(0);
  const text = artifacts.map((a) => new TextDecoder().decode(a.bytes)).join('\n');
  expect(text).toContain('displaceVertex');
  expect(text).toContain('displacedNormal');
  expect(text).toContain('textureSampleLevel');
}, 120_000);
