import * as naga from '@forgeax/engine-naga';
import { compileShader } from '@forgeax/engine-shader-compiler';
import { afterEach, expect, it, vi } from 'vitest';
import {
  compileMaterialSources,
  type MaterialCompileJob,
} from '../engine-inputs/compile-material-sources.js';

const previousWorkers = process.env.FORGEAX_SHADER_COMPILE_WORKERS;
afterEach(() => {
  if (previousWorkers === undefined) delete process.env.FORGEAX_SHADER_COMPILE_WORKERS;
  else process.env.FORGEAX_SHADER_COMPILE_WORKERS = previousWorkers;
  vi.restoreAllMocks();
});

it('reuses composition in a single-worker batch while validating each selected entry', async () => {
  process.env.FORGEAX_SHADER_COMPILE_WORKERS = '1';
  const source = `#import test::color::{color}
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return color(); }`;
  const imports = {
    'test::color':
      '#define_import_path test::color\nfn color() -> vec4<f32> { return vec4<f32>(0.25); }',
  };
  const jobs: MaterialCompileJob[] = ['first', 'second', 'invalid'].map((id) => ({
    defines: undefined,
    file: { id, source },
    options: {
      id,
      imports,
      renderEntries: {
        vertex: 'vs_main',
        fragment: id === 'invalid' ? 'missing_fragment' : 'fs_main',
      },
    },
  }));
  const expected = await compileShader(source, jobs[0]?.options);
  expect(expected.ok).toBe(true);
  const compose = vi.spyOn(naga, 'composeShader');
  const results = await compileMaterialSources(jobs, imports);
  expect(results[0]).toEqual(expected);
  expect(results[1]).toEqual(expected);
  expect(results[2]?.ok).toBe(false);
  expect(compose).toHaveBeenCalledTimes(1);
}, 60_000);
