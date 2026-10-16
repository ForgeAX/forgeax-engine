import { describe, expect, it } from 'vitest';
import { projectDirectionalShadowInspection } from '../../../render/src/assembly/directional-shadow-inspection';
import { resolveDirectionalShadowBackendAdmission } from '../../../render/src/render-pipeline';

describe('M3 inspection zero-delta structural budget', () => {
  it('keeps PCF and PCSS on the same shadow map and writer budget', () => {
    const common = {
      cascadeCount: 4,
      mapSize: 2048,
      shadowMapBytes: 67_108_864,
      writerPasses: 4,
      deviceGeneration: 1,
      graphGeneration: 2,
    } as const;
    const pcf = projectDirectionalShadowInspection({
      admission: resolveDirectionalShadowBackendAdmission({
        backendKind: 'webgpu',
        requested: 'pcf5',
        candidate: 'accepted',
      }),
      ...common,
      blockerTaps: 0,
      filterTapUpperBound: 25,
      seamTapUpperBound: 25,
    });
    const pcss = projectDirectionalShadowInspection({
      admission: resolveDirectionalShadowBackendAdmission({
        backendKind: 'webgpu',
        requested: 'pcssHigh',
        candidate: 'accepted',
      }),
      ...common,
      blockerTaps: 16,
      filterTapUpperBound: 32,
      seamTapUpperBound: 96,
    });
    expect(pcss).toMatchObject({ effective: 'pcssHigh', cascadeCount: 4, mapSize: 2048 });
    expect(pcf.writerPasses).toBe(pcss.writerPasses);
    expect(pcf.shadowMapBytes).toBe(pcss.shadowMapBytes);
    expect(pcf.graphGeneration).toBe(pcss.graphGeneration);
  });
});
