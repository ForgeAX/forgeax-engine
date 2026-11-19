import { fileURLToPath } from 'node:url';
import {
  type MaterialAsset,
  standardMaterialParameters,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { cookMaterialAsset } from '../material/cook';
import { collectMaterialSources } from '../material/pack-cooker';
import { buildMaterialSourceCatalog } from '../material/source-catalog';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT } from '../material/variant-context';

const root = fileURLToPath(new URL('../../../shader/src', import.meta.url));
const inputs = await collectMaterialSources([root], [root]);
const sources = buildMaterialSourceCatalog({
  ...inputs,
  project: [
    {
      path: '/virtual/vertex-material-surface.wgsl',
      source: `#define_import_path test::vertex_material_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::parameters::{material}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(material.tint.rgb, normalize(input.vertexNormalWS), 0.0, 0.5,
    vec3<f32>(0.0), 1.0, 1.0, 0.0, 0.0);
}`,
    },
  ],
}).unwrap();

it.each([
  { geometry: 'mesh', displaced: false },
  { geometry: 'skinned', displaced: false },
  { geometry: 'mesh', displaced: true },
  { geometry: 'skinned', displaced: true },
] as const)('keeps custom Surface material reads in their actual stages ($geometry displaced=$displaced)', async ({
  geometry,
  displaced,
}) => {
  const asset: MaterialAsset = {
    kind: 'material',
    parameters: standardSurfaceParameters([
      { name: 'tint', type: 'color' },
      ...standardMaterialParameters(new Set(displaced ? ['displacementTexture'] : [])),
    ]),
    surface: { model: 'standard', module: 'test::vertex_material_surface' },
    staticSwitches: { alphaClipping: false, alphaHash: false },
    passes: [
      {
        name: 'Forward',
        program: {
          module:
            geometry === 'skinned' ? 'forgeax_material::pbr-skin' : 'forgeax_material::standard',
        },
      },
    ],
  };
  const result = (
    await cookMaterialAsset({
      material: 'root',
      table: { root: asset },
      sources,
      context: { ...DEFAULT_MATERIAL_VARIANT_CONTEXT, geometry },
    })
  ).unwrap();
  const pass = result.passes[0];
  if (pass?.sceneCompile === undefined) throw new Error('Expected actual scene-index compilation');
  const entries = pass.sceneCompile.reflection.entryPoints;
  const vertex = entries?.find((entry) => entry.name === 'vs_scene_index');
  const fragment = entries?.find((entry) => entry.name === 'fs_main');
  expect(vertex).toBeDefined();
  expect(fragment).toBeDefined();
  const materialRead = (entry: typeof vertex) =>
    entry?.bindings.some((binding) => binding.group === 1 && binding.binding === 46);
  expect(materialRead(vertex)).toBe(displaced);
  expect(materialRead(fragment)).toBe(true);
  expect(
    pass.compile.reflection.entryPoints
      ?.find((entry) => entry.name === 'fs_main')
      ?.bindings.some((binding) => binding.group === 1 && binding.binding === 0),
  ).toBe(true);
  expect(pass.abi.positionBounds).toBe('standard-input');
});
