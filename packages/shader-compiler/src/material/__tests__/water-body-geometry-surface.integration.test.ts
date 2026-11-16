import { readFile } from 'node:fs/promises';
import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  cookMaterialAsset,
  materialShaderSourceRoots,
} from '../../index.js';

it('cooks the authored geometry Surface against the current Standard pass ABI', async () => {
  const roots = materialShaderSourceRoots();
  const collected = await collectMaterialSources(roots, roots);
  const sources = buildMaterialSourceCatalog({
    roots,
    engine: collected.engine,
    project: [
      ...collected.project,
      {
        path: 'assets/geometry-surface.wgsl',
        source: await readFile(
          new URL(
            '../../../../../apps/water/body-geometry/assets/geometry-surface.wgsl',
            import.meta.url,
          ),
          'utf8',
        ),
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
          moduleSlots: { surface: 'water_r1::geometry_surface' },
        },
      },
      {
        name: 'deferred',
        program: {
          module: 'forgeax_material::standard',
          fragmentEntry: 'fs_gbuffer',
          moduleSlots: { surface: 'water_r1::geometry_surface' },
        },
      },
      {
        name: 'shadow-caster',
        program: {
          module: 'forgeax::default-shadow-caster',
          fragmentEntry: 'fs_shadow',
          moduleSlots: { surface: 'water_r1::geometry_surface' },
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
