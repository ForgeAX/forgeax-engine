import { buildMaterialSourceCatalog, cookMaterialAsset } from '@forgeax/engine/shader-compiler';
import type { MaterialAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

const SOURCE = `#define_import_path lab::pulse
@vertex
fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let sample = textureSample(baseColorTexture, baseColorTexture_sampler, vec2<f32>(0.5));
  return material.baseColor * sample;
}
`;

const MATERIAL: MaterialAsset = {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'lab::pulse' } }],
  parameters: [
    { name: 'baseColor', type: 'color' },
    { name: 'baseColorTexture', type: 'texture' },
  ],
  values: { baseColor: [1, 0.2, 0.6, 1] },
};

export default defineFeature({
  title: 'Custom Material Shader (cook)',
  catalog: 'Custom Material Shader',
  kind: 'headless',
  summary:
    'User WGSL plus a MaterialAsset go through the same cook as engine materials: the cooker generates the parameter module from the declared parameters, composes, validates and reflects.',
  expect:
    'All checks pass: the custom pass cooks with a generated parameter module and a closure digest, and a WGSL typo fails the cook with a structured code instead of producing a material.',
  async run(checks) {
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'pulse.wgsl', source: SOURCE }],
    });
    checks.ok('source catalog builds', catalog.ok);
    if (!catalog.ok) return;
    const cooked = await cookMaterialAsset({
      material: 'root',
      table: { root: MATERIAL },
      sources: catalog.value,
    });
    checks.ok('custom material cooks', cooked.ok, cooked.ok ? undefined : cooked.error.code);
    if (cooked.ok) {
      const pass = cooked.value.passes[0];
      checks.equal('cooked pass module', pass?.module, 'lab::pulse');
      checks.ok('parameter module generated', (pass?.generatedModule.length ?? 0) > 0);
      checks.ok(
        'source closure digest',
        typeof pass?.sourceClosureDigest === 'string' && pass.sourceClosureDigest.length > 0,
      );
      checks.ok(
        'composed WGSL has the fragment entry',
        pass?.compile.wgsl.includes('fs_main') === true,
      );
    }

    const broken = buildMaterialSourceCatalog({
      engine: [],
      project: [
        { path: 'pulse.wgsl', source: SOURCE.replace('material.baseColor', 'material.baseColour') },
      ],
    });
    if (broken.ok) {
      const failed = await cookMaterialAsset({
        material: 'root',
        table: { root: MATERIAL },
        sources: broken.value,
      });
      checks.ok('WGSL typo fails the cook', !failed.ok, failed.ok ? 'cooked' : failed.error.code);
    }
  },
});
