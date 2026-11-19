import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../compile';

const source = (name: string) =>
  readFileSync(new URL(`../../../shader/src/${name}`, import.meta.url), 'utf8');

it.each([
  'fs_ssao_spiral',
  'fs_ssao_spiral_blur_x',
  'fs_ssao_spiral_blur_y',
])('compiles the native scalar %s entry without normal/noise/kernel inputs', async (fragment) => {
  const result = await compileShader(source('hdrp-ssao.wgsl'), {
    imports: {
      'forgeax_view::common': source('common.wgsl'),
      'forgeax_pbr::gbuffer': source('standard-gbuffer.wgsl'),
    },
    renderEntries: { vertex: 'vs_ssao', fragment },
  });
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  expect(
    result
      .unwrap()
      .reflection.entryPoints?.find((entry) => entry.name === fragment)
      ?.bindings.map((entry) => entry.binding)
      .sort((a, b) => a - b),
  ).toEqual(fragment === 'fs_ssao_spiral' ? [0, 12] : [6, 7, 12]);
});

it.each([
  ['fs_ssao_linear_depth', [0, 5]],
  ['fs_ssao_scene_color', [0, 5, 7, 10, 11, 12]],
  ['fs_ssao_linear_depth_msaa', [0, 13]],
  ['fs_ssao_scene_color_msaa', [0, 7, 10, 11, 12, 13]],
] as const)('publishes exact native reads for %s', async (fragment, bindings) => {
  const result = await compileShader(source('hdrp-ssao.wgsl'), {
    imports: {
      'forgeax_view::common': source('common.wgsl'),
      'forgeax_pbr::gbuffer': source('standard-gbuffer.wgsl'),
    },
    renderEntries: { vertex: 'vs_ssao', fragment },
  });
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  expect(
    result
      .unwrap()
      .reflection.entryPoints?.find((entry) => entry.name === fragment)
      ?.bindings.map((entry) => entry.binding)
      .sort((a, b) => a - b),
  ).toEqual(bindings);
});
