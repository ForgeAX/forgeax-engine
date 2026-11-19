import { expect, it } from 'vitest';
import {
  materialProgramContextForPass,
  materialProgramContextKey,
  validateMaterialCookProgramContext,
} from '../evidence/material-cook';

const base = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
} as const;

it('publishes independent LOD and receiving-view clipping identities', () => {
  const keys = new Set<string>();
  for (const lodCoverage of [false, true])
    for (const viewClipping of [false, true]) {
      const context = {
        ...base,
        ...(lodCoverage ? { lodCoverage: true as const } : {}),
        ...(viewClipping ? { viewClipping: true as const } : {}),
      };
      expect(validateMaterialCookProgramContext(context).ok).toBe(true);
      keys.add(materialProgramContextKey(context));
      for (const mode of ['Forward', 'GBuffer', 'ShadowCaster', 'Depth']) {
        const projected = materialProgramContextForPass(context, mode);
        expect('lodCoverage' in projected && projected.lodCoverage).toBe(lodCoverage || false);
        expect(projected.viewClipping === true).toBe(viewClipping);
      }
    }
  expect(keys.size).toBe(4);
  for (const lodCoverage of [false, 0, 1, 'true', null])
    expect(validateMaterialCookProgramContext({ ...base, lodCoverage }).ok).toBe(false);
});
