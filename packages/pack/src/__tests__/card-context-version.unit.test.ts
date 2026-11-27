import { expect, it } from 'vitest';
import { validateMaterialCookProgramContext } from '../evidence/material-cook';

const base = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'ray',
  geometry: 'mesh',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};
it.each([
  'v2',
  'v3',
])('rejects a retired Card-%s qualification profile with recook recovery', (version) => {
  expect(
    validateMaterialCookProgramContext({
      ...base,
      pass: 'card-capture',
      profile: `forgeax-material-card-${version}`,
    }),
  ).toMatchObject({
    ok: false,
    error: {
      code: 'material-cook-record-invalid',
      detail: { field: 'context.profile' },
      hint: expect.stringContaining('re-cook'),
    },
  });
});
it.each([
  ['ray-hit', 'forgeax-material-ray-v1'],
  ['card-capture', 'forgeax-material-card-v4'],
])('accepts the paired context ABI %s/%s', (pass, profile) => {
  expect(validateMaterialCookProgramContext({ ...base, pass, profile }).ok).toBe(true);
});
it.each([
  ['card-capture', 'forgeax-material-ray-v1'],
  ['card-capture', undefined],
  ['ray-hit', 'forgeax-material-card-v4'],
])('refuses old, missing or mismatched Card ABI %s/%s with recook recovery', (pass, profile) => {
  expect(validateMaterialCookProgramContext({ ...base, pass, profile })).toMatchObject({
    ok: false,
    error: {
      code: 'material-cook-record-invalid',
      hint: expect.stringContaining('re-cook'),
      detail: { field: 'context.profile' },
    },
  });
});
