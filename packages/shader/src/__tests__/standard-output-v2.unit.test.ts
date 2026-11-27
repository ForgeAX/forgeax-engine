import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';
import { STANDARD_OUTPUT_V2_PARAMS_LAYOUT } from '../standard-output';
import { TONEMAP_PARAMS_LAYOUT } from '../tonemap';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const imports = {
  'forgeax_view::common': source('common.wgsl'),
  'forgeax_view::output_encoding': source('output-encoding.wgsl'),
  'forgeax_view::tone_mapping': source('tone-mapping.wgsl'),
  'forgeax_view::smaa_blend': source('smaa-blend.wgsl'),
};

it('publishes finite native Grade/Final entries with only their selected resource reads', async () => {
  const result = await compileShader(source('standard-output-v2.wgsl'), { imports });
  if (!result.ok) throw result.error;
  const entries = result.value.reflection.entryPoints;
  if (entries === undefined) throw Error('Native output compilation omitted selected entry reads');
  for (const name of [
    'fs_grade',
    'fs_grade_lut',
    'fs_grade_bloom',
    'fs_grade_lut_bloom',
    'fs_encode',
    'fs_smaa_encode',
    'fs_final',
    'fs_final_fxaa',
  ]) {
    const entry = entries.find((entry) => entry.name === name && entry.stage === 'fragment');
    expect(entry, name).toBeDefined();
    const reads = entry?.bindings.map((read) => `${read.group}:${read.binding}`).sort();
    expect(reads).toContain('0:0');
    expect(reads?.includes('0:1')).toBe(name !== 'fs_smaa_encode');
    expect(reads).toContain('0:2');
    expect(reads?.includes('0:3')).toBe(name.startsWith('fs_grade'));
    expect(reads?.includes('1:0')).toBe(name.includes('lut'));
    expect(reads?.includes('1:1')).toBe(name.includes('lut'));
    expect(reads?.includes('0:4')).toBe(name.includes('bloom') || name === 'fs_smaa_encode');
    for (const binding of [5, 6, 7, 8]) expect(reads).not.toContain(`0:${binding}`);
    expect(entry?.effects).toEqual({
      mayDiscard: false,
      writesDepth: false,
      writesSampleMask: false,
      writesStorage: false,
    });
  }
  expect(STANDARD_OUTPUT_V2_PARAMS_LAYOUT.byteSize).toBe(160);
  expect(STANDARD_OUTPUT_V2_PARAMS_LAYOUT.policyOffset + 16).toBe(
    STANDARD_OUTPUT_V2_PARAMS_LAYOUT.byteSize,
  );
  const uniform = result.value.reflection.boundGlobals.find(
    (global) => global.group === 0 && global.binding === 2,
  );
  expect(uniform?.span).toBe(STANDARD_OUTPUT_V2_PARAMS_LAYOUT.byteSize);
  expect(uniform?.members?.map((member) => [member.name, member.offset])).toEqual([
    ['exposureTone', 0],
    ['whiteBalanceR', 16],
    ['whiteBalanceG', 32],
    ['whiteBalanceB', 48],
    ['fringeLut', 64],
    ['bloom', 80],
    ['vignette', 96],
    ['vignetteColor', 112],
    ['finish', 128],
    ['policy', 144],
  ]);
  expect(TONEMAP_PARAMS_LAYOUT.byteSize).toBe(32);
});
