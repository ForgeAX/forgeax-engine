import { expect, it } from 'vitest';
import {
  type MaterialCookRasterContext,
  materialProgramContextForPass,
  materialProgramContextKey,
  validateMaterialCookProgramContext,
} from '../evidence/material-cook';

const base: MaterialCookRasterContext = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};
it('owns view clipping independently from the output ABI and pass', () => {
  const clipped = { ...base, viewClipping: true } as const;
  expect(validateMaterialCookProgramContext(clipped).ok).toBe(true);
  expect(materialProgramContextKey(clipped)).not.toBe(materialProgramContextKey(base));
  for (const mode of ['Forward', 'Deferred', 'GBuffer', 'ShadowCaster', 'Depth']) {
    expect(materialProgramContextForPass(clipped, mode).viewClipping).toBe(true);
    expect(materialProgramContextForPass(base, mode).viewClipping).toBeUndefined();
  }
});
it('admits one explicit on representation and rejects raw compiler axes', () => {
  for (const viewClipping of [false, 0, 1, 'true', null])
    expect(validateMaterialCookProgramContext({ ...base, viewClipping }).ok).toBe(false);
  expect(validateMaterialCookProgramContext({ ...base, CLIPPING_PLANES: true }).ok).toBe(false);
});
