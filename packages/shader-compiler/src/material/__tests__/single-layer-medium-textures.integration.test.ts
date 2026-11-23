import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derive } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { cookMaterialAsset } from '../cook.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

it.each([
  1, 3,
])('cooks %i authored medium textures without aliasing Engine optical resources', async (count) => {
  const root = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  const engine = (
    await Promise.all(
      (
        await readdir(root, { recursive: true })
      )
        .filter((name) => name.endsWith('.wgsl'))
        .map(async (name) => ({ path: name, source: await readFile(resolve(root, name), 'utf8') })),
    )
  ).filter((row) => row.source.includes('#define_import_path'));
  const names = Array.from({ length: count }, (_, index) => `normal${index}`);
  const surface = `#define_import_path game::textured_medium
#import forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput, SingleLayerMediumSurfaceData}
#import forgeax_material::parameters::{material, ${names.flatMap((name) => [name, `${name}_sampler`]).join(', ')}}
fn evaluate_surface(input: SingleLayerMediumSurfaceInput) -> SingleLayerMediumSurfaceData {
  let tint = ${names.map((name) => `textureSampleLevel(${name}, ${name}_sampler, input.uv0, 0.0).rgb`).join(' + ')};
  return SingleLayerMediumSurfaceData(input.geometricNormalWS, 0.25, material.coverage, 0.0,
    tint * 0.1, vec3<f32>(0.01), 1.333, 0.0, 20.0);
}`;
  const catalog = buildMaterialSourceCatalog({
    engine,
    project: [{ path: 'water.wgsl', source: surface }],
  }).unwrap();
  const cooked = await cookMaterialAsset({
    material: 'water',
    table: {
      water: {
        kind: 'material',
        surface: { model: 'single-layer-medium', module: 'game::textured_medium' },
        passes: [{ name: 'color', program: { module: 'forgeax::single-layer-medium' } }],
        parameters: [
          { name: 'coverage', type: 'f32' },
          ...names.map((name) => ({ name, type: 'texture' as const })),
        ],
        values: { coverage: 1 },
      },
    },
    sources: catalog,
  });
  expect(cooked.ok, cooked.ok ? '' : cooked.error.message).toBe(true);
  if (!cooked.ok) return;
  const pass = cooked.value.passes[0];
  if (!pass) throw new Error('Expected the cooked medium pass');
  const start = derive(pass.paramSchema).userRegionBindingEnd;
  expect(pass.sceneCompile).toBeDefined();
  if (!pass.sceneCompile) throw new Error('Expected the scene-index medium program');
  for (const program of [pass.compile, pass.sceneCompile]) {
    const resources = program.reflection.boundGlobals;
    const keys = resources.map((global) => `${global.group}:${global.binding}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(resources.find((global) => global.name === 'mediumSkySh')).toMatchObject({
      group: 1,
      binding: start,
    });
    expect(resources.find((global) => global.name === 'surfaceRawDepthTexture')).toMatchObject({
      group: 1,
      binding: start + 9,
    });
    expect(resources.find((global) => global.name === 'planarReflection')).toMatchObject({
      group: 1,
      binding: start + 15,
    });
    expect(resources.find((global) => global.group === 1 && global.binding === 2)).toMatchObject({
      group: 1,
      binding: 2,
    });
  }
});
