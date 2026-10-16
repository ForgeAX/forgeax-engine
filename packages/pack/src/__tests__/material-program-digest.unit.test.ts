import type { MaterialPass } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  createMaterialProgramSetDigest,
  type MaterialCookProgram,
  type MaterialCookRasterContext,
} from '../evidence/material-cook.js';

it('preserves the program manifest digest across sorting and byte transport', () => {
  const context: MaterialCookRasterContext = {
    backend: 'webgpu',
    capability: 'storage-buffer',
    pipeline: 'forward',
    geometry: 'mesh',
    pass: 'forward',
    profile: 'forgeax-material-wgsl-v1',
    toolchain: 'naga-oil',
    instrumentation: 'none',
  };
  const programs: MaterialCookProgram[] = ['z', 'a'].map((key) => ({
    specializationKey: key,
    artifact: {
      path: `${key}.wgsl`,
      mediaType: 'text/wgsl',
      digest: `sha256:${key}`,
      bytes: new Uint8Array([1, 2]),
    },
    selections: [
      { pass: 'forward', context },
      { pass: 'forward', context: { ...context, geometry: 'skinned' } },
    ],
  }));
  const passes: MaterialPass[] = [{ name: 'forward', program: { module: 'fixture' } }];
  // Captured from the previous canonical serialization, before the sort change.
  const digest = 'sha256:6e6fb2268e8ae71068b665e95237acebb3134dc003c3f5cdfe0ecdb57ee4ff37';
  expect(createMaterialProgramSetDigest(programs, passes)).toBe(digest);
  const reordered = [...programs].reverse().map((program) => ({
    ...program,
    artifact: { ...program.artifact, bytes: new Uint8Array([8, 9, 10]) },
    selections: [...program.selections].reverse(),
  }));
  expect(createMaterialProgramSetDigest(reordered, passes)).toBe(digest);
});
