import { isSupportedVariantDefines } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { applySurfaceDiscardAxis, materialAbiRasterConstants } from '../material-stage-constants';

it('selects LOD and camera clipping independently for every coverage mask', () => {
  for (const mask of [0, 1, 2, 3]) {
    const selected = applySurfaceDiscardAxis(
      'CLIPPING_PLANES=false+LOD_DITHER=false',
      materialAbiRasterConstants(undefined, mask),
    );
    expect(selected.constants).toBeUndefined();
    expect(selected.variantSet).toBe(
      `CLIPPING_PLANES=${(mask & 2) !== 0}+LOD_DITHER=${(mask & 1) !== 0}`,
    );
    expect(
      isSupportedVariantDefines({
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
        CLIPPING_PLANES: (mask & 2) !== 0,
        LOD_DITHER: (mask & 1) !== 0,
      }),
    ).toBe(true);
  }
});
