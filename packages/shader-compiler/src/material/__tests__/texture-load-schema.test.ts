import { fileURLToPath } from 'node:url';
import {
  derive,
  type MaterialAsset,
  projectMaterialParameterSchema,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { compareMaterialBindings } from '../../compare-param-schema.js';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  compileShader,
  cookMaterialAsset,
} from '../../index.js';

const schema = projectMaterialParameterSchema(
  [{ name: 'color', type: 'texture', sampleType: 'unfilterable-float' }],
  '<anonymous>',
  'cook',
).unwrap();

it.each([
  'storage-buffer',
  'uniform-fallback',
] as const)('cooks a Standard Surface float-data texture through all passes: %s', async (capability) => {
  const rows = await collectMaterialSources([
    fileURLToPath(new URL('../../../../shader/src', import.meta.url)),
  ]);
  const lookup = {
    path: 'lookup.wgsl',
    source: `#define_import_path test::lookup
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::parameters::{baseColorTexture}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let color = textureLoad(baseColorTexture, vec2<i32>(0), 0);
  return SurfaceData(color.rgb, input.vertexNormalWS, 0.0, 0.95, vec3<f32>(0.0), 1.0, color.a, 0.0);
}`,
  };
  const material: MaterialAsset = {
    kind: 'material' as const,
    parameters: standardSurfaceParameters([
      { name: 'baseColorTexture', type: 'texture', sampleType: 'unfilterable-float' },
    ]),
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax_material::standard', moduleSlots: { surface: 'test::lookup' } },
      },
    ],
  };
  const result = await cookMaterialAsset({
    material: 'lookup',
    table: { lookup: material },
    sources: buildMaterialSourceCatalog({ ...rows, project: [...rows.project, lookup] }).unwrap(),
    context: {
      backend: 'webgpu',
      pipeline: 'forward',
      geometry: 'mesh',
      pass: 'forward',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
      capability,
    },
  });
  expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
  if (!result.ok) return;
  for (const pass of result.value.passes) {
    expect(pass.sceneCompile !== undefined).toBe(capability === 'storage-buffer');
    expect(pass.abi?.sceneIndexEntry).toBe(
      capability === 'storage-buffer' ? 'vs_scene_index' : undefined,
    );
    const interface_ = derive(pass.paramSchema);
    const resource = interface_.resourceBindings.find(
      (entry) => entry.kind === 'texture' && entry.parameter === 'baseColorTexture',
    );
    expect(resource).toBeDefined();
    expect(
      interface_.bglEntries.find((entry) => entry.binding === resource?.binding)?.texture
        ?.sampleType,
    ).toBe('unfilterable-float');
  }
}, 30_000);
async function compile(expression: string) {
  const result = await compileShader(
    `
@group(1) @binding(1) var color_sampler: sampler;
@group(1) @binding(2) var color: texture_2d<f32>;
@fragment fn fs_main() -> @location(0) vec4<f32> { return ${expression}; }
`,
    { id: 'test::texture-load-schema' },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value.bindings;
}

it('lowers the float-data contract to a distinct runtime layout with unchanged storage', async () => {
  const bindings = await compile('textureLoad(color, vec2<i32>(0), 0)');
  expect(compareMaterialBindings(schema, bindings, 'test::load').ok).toBe(true);
  const derived = derive(schema);
  const filtering = derive([{ name: 'color', type: 'texture2d' }]);
  expect(derived.bglEntries.find((entry) => entry.binding === 2)?.texture?.sampleType).toBe(
    'unfilterable-float',
  );
  expect(derived.layoutIdentity).not.toBe(filtering.layoutIdentity);
  expect(derived.totalBytes).toBe(filtering.totalBytes);
});

it('rejects filtering shader use against a load-only texture contract', async () => {
  const bindings = await compile('textureSample(color, color_sampler, vec2<f32>(0.5))');
  expect(compareMaterialBindings(schema, bindings, 'test::sample').ok).toBe(false);
});

it('invalidates the unadmitted layout cache when the sample type changes', () => {
  const parameter: { name: string; type: 'texture2d'; sampleType?: 'unfilterable-float' } = {
    name: 'color',
    type: 'texture2d',
  };
  const mutable = [parameter];
  const previous = derive(mutable);
  parameter.sampleType = 'unfilterable-float';
  expect(derive(mutable).layoutIdentity).not.toBe(previous.layoutIdentity);
});
