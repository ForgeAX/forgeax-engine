// shadow-csm-viewport.browser.test.ts - directional shadow browser admission.
// Per-cascade layer retention is proven against a real device by
// packages/render/src/__tests__/shadow-partial-cache.dawn.test.ts.

import { describe, expect, it } from 'vitest';
import { projectDirectionalShadowInspection } from '../../../render/src/assembly/directional-shadow-inspection';
import { resolveDirectionalShadowBackendAdmission } from '../../../render/src/render-pipeline';

describe('M3 Browser backend admission', () => {
  it('admits WebGL2 PCSS without changing the cascade layer contract', () => {
    const inspection = projectDirectionalShadowInspection({
      admission: resolveDirectionalShadowBackendAdmission({
        backendKind: 'wgpu-webgl2',
        requested: 'pcssHigh',
        candidate: 'accepted',
      }),
      cascadeCount: 4,
      mapSize: 2048,
      shadowMapBytes: 67_108_864,
      writerPasses: 4,
      blockerTaps: 16,
      filterTapUpperBound: 32,
      seamTapUpperBound: 96,
      deviceGeneration: 1,
      graphGeneration: 1,
    });
    expect(inspection).toMatchObject({
      effective: 'pcssHigh',
      status: 'accepted',
      cascadeCount: 4,
      mapSize: 2048,
    });
  });
});
