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

async function cookedForwardText(declareMode: boolean, declareHost = true): Promise<string> {
  const parameters = standardSurfaceParameters([
    { name: 'normalTexture', type: 'texture' },
    { name: 'displacementTexture', type: 'texture' },
    ...(declareHost ? [{ name: 'metallicTexture', type: 'texture' } as const] : []),
  ]).filter((parameter) => declareMode || parameter.name !== 'displacementMode');
  const source: MaterialAsset = {
    kind: 'material',
    parameters,
    passes: [
      {
        name: 'forward',
        program: {
          module: 'forgeax_material::standard',
          moduleSlots: { surface: 'forgeax_material::default_standard_surface' },
        },
      },
    ],
  };
  const cooked = await createMaterialPackCooker().cook({
    guid: `standard-parallax-${declareMode}-${declareHost}`,
    source,
  });
  return Object.values(cooked.artifacts)
    .map((a) => new TextDecoder().decode(a.bytes))
    .join('\n');
}

it('selects cooked parallax from the declared closed mode and keeps tangent and basis inputs', async () => {
  const text = await cookedForwardText(true);
  expect(text).toContain('parallaxSourceUvOffset');
  expect(text).toContain('textureSampleGrad');
  expect(text).not.toContain('parallaxHeightTexture');
  // The march reads the height through the derived metallic host pair (naga-oil mangles the callee).
  expect(text).toMatch(/= parallaxSourceUvOffset\w*\(metallicTexture, metallicTexture_sampler/);
  expect(text).toMatch(/let (\w+) = material\.displacementMode;\s*return \(\1 == 1u\);/);
  expect(text).toMatch(/@location\(3\)\s+tangent\s*:/);
  expect(text).toMatch(/objectBasis0/);
}, 120_000);

it('leaves a root without displacementMode on the unchanged vertex path', async () => {
  const text = await cookedForwardText(false);
  expect(text).not.toContain('parallaxSourceUvOffset');
  expect(text).not.toContain('material.displacementMode');
}, 120_000);

it('keeps plain normal mapping in a sparse cooked root without the metallic host pair', async () => {
  const text = await cookedForwardText(true, false);
  expect(text).not.toMatch(/= parallaxSourceUvOffset\w*\(/);
  expect(text).toMatch(/let (\w+) = material\.displacementMode;\s*return \(\1 == 1u\);/);
}, 120_000);
