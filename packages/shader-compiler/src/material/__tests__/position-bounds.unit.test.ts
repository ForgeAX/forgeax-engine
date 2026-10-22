import { expect, it } from 'vitest';
import { cookMaterialAsset } from '../cook';
import { buildMaterialSourceCatalog } from '../source-catalog';

it.each([
  'project-dependency',
  'unknown-entry',
] as const)('withholds a stock position proof from %s through the real compiler', async (reason) => {
  const dependency = reason === 'project-dependency';
  const entry = dependency ? 'vs_main' : 'vs_other';
  const sources = buildMaterialSourceCatalog({
    engine: [
      {
        path: 'unlit.wgsl',
        source: `#define_import_path forgeax_material::unlit
${dependency ? '#import game::deformation::{warpPosition}' : ''}
@vertex fn ${entry}() -> @builtin(position) vec4<f32> {
  return ${dependency ? 'warpPosition()' : 'vec4<f32>(0.0,0.0,0.0,1.0)'};
}
@fragment fn fs_main() -> @location(0) vec4<f32> {return vec4<f32>(1.0);}
`,
      },
    ],
    project: dependency
      ? [
          {
            path: 'deformation.wgsl',
            source: `#define_import_path game::deformation
fn warpPosition() -> vec4<f32> {return vec4<f32>(9.0,0.0,0.0,1.0);}
`,
          },
        ]
      : [],
  }).unwrap();
  const cooked = await cookMaterialAsset({
    material: 'position-test',
    sources,
    table: {
      'position-test': {
        kind: 'material',
        passes: [
          { name: 'Forward', program: { module: 'forgeax_material::unlit', vertexEntry: entry } },
        ],
      },
    },
  });
  expect(cooked.ok, cooked.ok ? '' : cooked.error.message).toBe(true);
  if (!cooked.ok) throw cooked.error;
  expect(cooked.value.passes).toHaveLength(1);
  expect(cooked.value.passes[0]?.abi.positionBounds).toBeUndefined();
});

it.each([
  'forgeax_material::unlit',
  'forgeax::default-unlit',
])('publishes one stock position proof for Engine module identifier %s', async (module) => {
  const source = `#define_import_path ${module}
@vertex fn vs_main() -> @builtin(position) vec4<f32> {return vec4<f32>(0.0,0.0,0.0,1.0);}
@fragment fn fs_main() -> @location(0) vec4<f32> {return vec4<f32>(1.0);}
`;
  const sources = buildMaterialSourceCatalog({
    engine: [{ path: 'unlit.wgsl', source }],
    project: [],
  }).unwrap();
  const cooked = await cookMaterialAsset({
    material: 'alias-test',
    sources,
    table: {
      'alias-test': { kind: 'material', passes: [{ name: 'Forward', program: { module } }] },
    },
  });
  expect(cooked.ok, cooked.ok ? '' : cooked.error.message).toBe(true);
  if (!cooked.ok) throw cooked.error;
  expect(cooked.value.passes[0]?.abi.positionBounds).toBe('standard-input');
});
