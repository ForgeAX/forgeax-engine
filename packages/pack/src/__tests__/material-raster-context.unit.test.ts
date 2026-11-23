import { expect, it } from 'vitest';
import {
  materialProgramContextForPass,
  materialProgramContextKey,
  validateMaterialCookProgramContext,
} from '../evidence/material-cook';
import { forwardRasterContext } from './support/material-raster-context.js';

const base = forwardRasterContext;

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
      for (const mode of ['Forward', 'Deferred', 'GBuffer', 'ShadowCaster', 'Depth']) {
        const projected = materialProgramContextForPass(context, mode);
        expect('lodCoverage' in projected && projected.lodCoverage).toBe(lodCoverage || false);
        expect(projected.viewClipping === true).toBe(viewClipping);
      }
    }
  expect(keys.size).toBe(4);
});

it('selects the same visible ABI for both color routes and leaves shadow/depth unchanged', () => {
  const visible = { ...base, visibleSurface: true } as const;
  expect(validateMaterialCookProgramContext(visible).ok).toBe(true);
  for (const mode of ['Forward', 'Deferred', 'GBuffer']) {
    const selected = materialProgramContextForPass(visible, mode);
    expect(selected.visibleSurface).toBe(true);
    expect(selected.pipeline).toBe(mode === 'Forward' ? 'forward' : 'deferred');
    expect(materialProgramContextKey(selected)).not.toBe(
      materialProgramContextKey(materialProgramContextForPass(base, mode)),
    );
  }
  for (const mode of ['ShadowCaster', 'Depth']) {
    expect(materialProgramContextForPass(visible, mode)).toEqual(
      materialProgramContextForPass(base, mode),
    );
  }
});

it('requires explicit raster axes and rejects raw compiler flags', () => {
  expect(validateMaterialCookProgramContext(base).ok).toBe(true);
  for (const axis of ['lodCoverage', 'viewClipping']) {
    for (const value of [false, 0, 1, 'true', null])
      expect(validateMaterialCookProgramContext({ ...base, [axis]: value }).ok).toBe(false);
  }
  for (const flag of ['CLIPPING_PLANES', 'VISIBLE_SURFACE_AVAILABLE'])
    expect(validateMaterialCookProgramContext({ ...base, [flag]: true }).ok).toBe(false);
  for (const visibleSurface of [false, 'true'])
    expect(validateMaterialCookProgramContext({ ...base, visibleSurface }).ok).toBe(false);
});
