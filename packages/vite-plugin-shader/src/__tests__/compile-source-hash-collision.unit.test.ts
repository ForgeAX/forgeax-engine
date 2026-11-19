import { ok } from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';

// Keep real native validation and source emission; force only the short bucket
// identity to collide so sharing cannot mistake it for complete source equality.
vi.mock('@forgeax/engine-shader-compiler', async (original) => {
  const actual = await original<typeof import('@forgeax/engine-shader-compiler')>();
  return {
    ...actual,
    createShaderProgramCompiler: () => {
      const compile = actual.createShaderProgramCompiler();
      return async (...args: Parameters<typeof compile>) => {
        const result = await compile(...args);
        return result.ok
          ? ok({
              ...result.value,
              manifestEntry: { ...result.value.manifestEntry, hash: '00000000' },
            })
          : result;
      };
    },
  };
});

import { compileMaterialSources } from '../engine-inputs/compile-material-sources';

afterEach(() => vi.unstubAllEnvs());

it('shares identical sources but retains distinct sources in a colliding hash bucket', async () => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
  const results = await compileMaterialSources(
    [0, 1, 0].map((index) => ({
      defines: undefined,
      file: {
        id: `collision-${index}`,
        source: `@compute @workgroup_size(1) fn work_${index}() {}`,
      },
      options: {},
    })),
    {},
  );
  const values = results.map((result) => result.unwrap());
  expect(values.map((value) => value.manifestEntry.hash)).toEqual([
    '00000000',
    '00000000',
    '00000000',
  ]);
  expect(values[0]?.wgsl).toContain('work_0');
  expect(values[1]?.wgsl).toContain('work_1');
  expect(values[2]?.wgsl).toBe(values[0]?.wgsl);
  expect(values[1]?.wgsl).not.toBe(values[0]?.wgsl);
  for (const value of values) expect(value.manifestEntry.wgsl).toBe(value.wgsl);
});
