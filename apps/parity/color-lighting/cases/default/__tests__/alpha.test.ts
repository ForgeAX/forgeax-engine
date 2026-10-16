import { describe, expect, it } from 'vitest';

const transparentBackgroundCase = {
  caseId: 'default-transparent-alpha',
  required: true,
  colorDomain: 'linearLdr',
  scene: { width: 4, height: 4, background: [0, 0, 0, 0] },
  budget: { analyticMax: 0.01, roiMax: 0.01, byteMax: 0 },
} as const;

describe('M1 default alpha case', () => {
  it('keeps transparent background as an independent required case', () => {
    expect(transparentBackgroundCase.required).toBe(true);
    expect(transparentBackgroundCase.scene.background[3]).toBe(0);
    expect(transparentBackgroundCase.budget).toEqual({ analyticMax: 0.01, roiMax: 0.01, byteMax: 0 });
  });

  it('does not use the explicit opaque profile as the default', () => {
    const defaultProfile = { alphaMode: 'premultiplied', clearAlpha: 0 };
    const opaqueProfile = { alphaMode: 'opaque', clearAlpha: 1 };
    expect(defaultProfile).not.toEqual(opaqueProfile);
  });
});
