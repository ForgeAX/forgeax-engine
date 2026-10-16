import { expect, it } from 'vitest';
import {
  type MaterialCookProgramContext,
  materialProgramContextForPass,
  materialProgramContextKey,
  validateMaterialCookProgramContext,
} from '../evidence/material-cook';

const context: MaterialCookProgramContext = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};

it('selects the same visible ABI for both color routes and leaves shadow/depth unchanged', () => {
  const visible = { ...context, visibleSurface: true } as const;
  expect(validateMaterialCookProgramContext(visible).ok).toBe(true);
  for (const mode of ['Forward', 'Deferred', 'GBuffer']) {
    const selected = materialProgramContextForPass(visible, mode);
    expect(selected.visibleSurface).toBe(true);
    expect(selected.pipeline).toBe(mode === 'Forward' ? 'forward' : 'deferred');
    expect(materialProgramContextKey(selected)).not.toBe(
      materialProgramContextKey(materialProgramContextForPass(context, mode)),
    );
  }
  for (const mode of ['ShadowCaster', 'Depth']) {
    expect(materialProgramContextForPass(visible, mode)).toEqual(
      materialProgramContextForPass(context, mode),
    );
  }
});

it('has one off representation and refuses undeclared context fields', () => {
  expect(validateMaterialCookProgramContext(context).ok).toBe(true);
  expect(validateMaterialCookProgramContext({ ...context, visibleSurface: false }).ok).toBe(false);
  expect(validateMaterialCookProgramContext({ ...context, visibleSurface: 'true' }).ok).toBe(false);
  expect(
    validateMaterialCookProgramContext({ ...context, VISIBLE_SURFACE_AVAILABLE: true }).ok,
  ).toBe(false);
});
