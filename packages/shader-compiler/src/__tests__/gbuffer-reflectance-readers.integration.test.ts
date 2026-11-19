import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../compile';

const source = (name: string) =>
  readFileSync(new URL(`../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
const imports = Object.fromEntries(
  (
    [
      ['forgeax_view::common', 'common'],
      ['forgeax_pbr::gbuffer', 'standard-gbuffer'],
      ['forgeax_pbr::ibl_shared', 'ibl-shared'],
      ['forgeax_pbr::ibl_sampling', 'ibl-sampling'],
      ['forgeax_pbr::brdf', 'brdf'],
      ['forgeax_pbr::pmrem', 'ibl-pmrem'],
    ] as const
  ).map(([id, file]) => [id, source(file)]),
);

it.each([
  'fs_ray_diffuse',
  'fs_ray_diffuse_reconstructed',
  'fs_ray_diffuse_reflections',
  'fs_ray_diffuse_reconstructed_reflections',
])('compiles independent dielectric reconstruction through the actual GI %s reader', async (fragment) => {
  const result = await compileShader(source('ray-diffuse-composite'), {
    imports,
    renderEntries: { vertex: 'vs_ray_diffuse', fragment },
  });
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.reflection.entryPoints?.some((entry) => entry.name === fragment)).toBe(true);
});
