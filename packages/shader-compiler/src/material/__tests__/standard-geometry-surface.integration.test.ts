import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  cookMaterialAsset,
  materialShaderSourceRoots,
} from '../../index.js';

const source = `#define_import_path test::geometry_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::parameters::{material}

fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let contour = 0.94 + 0.06 * cos(input.positionWS.y * 30.0);
  return SurfaceData(material.baseColor.rgb * contour, normalize(input.vertexNormalWS),
    0.02, material.roughness, vec3<f32>(0.0), 1.0, 1.0, 0.0, 0.0);
}`;

it('cooks an authored geometry Surface against the current Standard pass ABI', async () => {
  const roots = materialShaderSourceRoots();
  const collected = await collectMaterialSources(roots, roots);
  const sources = buildMaterialSourceCatalog({
    roots,
    engine: collected.engine,
    project: [
      ...collected.project,
      {
        path: 'assets/geometry-surface.wgsl',
        source,
      },
    ],
  }).unwrap();
  const material: MaterialAsset = {
    kind: 'material',
    colorSpace: 'linear',
    parameters: standardSurfaceParameters([
      { name: 'baseColor', type: 'color' },
      { name: 'roughness', type: 'f32' },
    ]),
    passes: [
      {
        name: 'forward',
        program: {
          module: 'forgeax_material::standard',
          fragmentEntry: 'fs_main',
          moduleSlots: { surface: 'test::geometry_surface' },
        },
      },
      {
        name: 'deferred',
        program: {
          module: 'forgeax_material::standard',
          fragmentEntry: 'fs_gbuffer',
          moduleSlots: { surface: 'test::geometry_surface' },
        },
      },
      {
        name: 'shadow-caster',
        program: {
          module: 'forgeax::default-shadow-caster',
          fragmentEntry: 'fs_shadow',
          moduleSlots: { surface: 'test::geometry_surface' },
        },
      },
    ],
    values: { baseColor: [0.025, 0.22, 0.28, 1], roughness: 0.22 },
  };
  const cooked = await cookMaterialAsset({
    material: 'geometry',
    table: { geometry: material },
    sources,
  });
  expect(cooked.ok, cooked.ok ? '' : cooked.error.message).toBe(true);
  if (!cooked.ok) throw cooked.error;
  expect(cooked.value.passes.length).toBeGreaterThan(0);
  expect(cooked.value.passes.every((pass) => pass.compile.reflection.entryPoints?.length)).toBe(
    true,
  );
});
