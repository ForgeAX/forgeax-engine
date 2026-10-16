import { buildMaterialSourceCatalog, cookMaterialAsset } from '@forgeax/engine/shader-compiler';
import type { MaterialAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

const SOURCE = `#define_import_path lab::gate
struct Material {
  baseColor : vec4<f32>,
};
@group(1) @binding(0) var<uniform> material : Material;
@vertex
fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
@fragment
fn fs_main() -> @location(0) vec4<f32> { return material.baseColor; }
`;

export default defineFeature({
  title: 'Material reflection gate',
  catalog: 'Material reflection gate',
  kind: 'headless',
  summary:
    'cookMaterialAsset reflects the compiled WGSL and compares it with the paramSchema-derived interface; a mismatch fails the cook before any load.',
  expect:
    'All checks pass: parameters matching the WGSL Material struct cook, and an extra declared parameter the WGSL does not carry fails with material-derived-interface-mismatch.',
  async run(checks) {
    const catalog = buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: 'gate.wgsl', source: SOURCE }],
    });
    checks.ok('source catalog builds', catalog.ok);
    if (!catalog.ok) return;
    const cook = (parameters: NonNullable<MaterialAsset['parameters']>) =>
      cookMaterialAsset({
        material: 'root',
        table: {
          root: {
            kind: 'material',
            passes: [{ name: 'Forward', program: { module: 'lab::gate' } }],
            parameters,
          },
        },
        sources: catalog.value,
      });
    const matching = await cook([{ name: 'baseColor', type: 'color' }]);
    checks.ok(
      'matching interface cooks',
      matching.ok,
      matching.ok ? undefined : matching.error.code,
    );
    const drifted = await cook([
      { name: 'baseColor', type: 'color' },
      { name: 'strength', type: 'f32' },
    ]);
    checks.equal(
      'drifted interface code',
      drifted.ok ? 'ok' : drifted.error.code,
      'material-derived-interface-mismatch',
    );
  },
});
