import { describe, expect, it, vi } from 'vitest';
import {
  type CloudDensityControls,
  type CloudDensityPoint,
  evaluateReferenceConservative,
  evaluateReferenceMedium,
  type ReferenceCloudTextures,
} from '../reference-model';

const point: CloudDensityPoint = {
  positionMeters: [2500, 5000, -10_000],
  cameraRelativeMeters: [0, 5500, 0],
  heightFraction: 0.5,
  windOffsetMeters: [10, 0, 20],
};
const controls: CloudDensityControls = {
  layoutScaleMeters: 1000,
  coverageBias: -0.2,
  extinctionPerMeter: 0.001,
  albedo: [0.9, 0.8, 0.7, 0.6],
  layoutWeight: 1,
  maskWeight: 1,
  profileWeight: 1,
  bodyWeight: 1,
  erosionWeight: 1,
};

function testTextures(): ReferenceCloudTextures {
  return {
    pattern: vi.fn(() => [0.2, 0.4, 0.6, 0.99] as const),
    mask: vi.fn(() => [0.25, 0.5, 0.75, 1] as const),
    profile: vi.fn(() => [0.65, 0.8, 0.75, 0.95] as const),
    body: vi.fn(() => [0.9, 0.75, 0.6, 0.2] as const),
  };
}

describe('sampled cloud reference domain', () => {
  it('preserves the UE desktop extinction root saturation after multiplying distance fade', () => {
    const opaque = { ...controls, extinctionPerMeter: 1 };
    const c4 = [1, 1, 4, 4] as const;
    expect(evaluateReferenceMedium(point, opaque, c4).extinctionPerMeter).toBe(1);
    expect(
      evaluateReferenceMedium({ ...point, cameraRelativeMeters: [25, 0, 0] }, opaque, c4)
        .extinctionPerMeter,
    ).toBeCloseTo(0.4, 12);
    expect(evaluateReferenceMedium(point, opaque, [1, 1, -4, 0]).extinctionPerMeter).toBe(0);
  });

  it('follows independent fixed-value C4 channel, layer, warp and source-axis expectations', () => {
    const textures = testTextures();
    const c4 = evaluateReferenceConservative(point, controls, textures, false);
    expect(textures.pattern).toHaveBeenCalledWith([10, 2.5]);
    expect(textures.mask).toHaveBeenCalledWith([10.5, 3]);
    expect(textures.profile).toHaveBeenNthCalledWith(1, [0.5, 0.2]);
    expect(textures.profile).toHaveBeenNthCalledWith(2, [0.5, 0.4]);
    expect(textures.profile).toHaveBeenNthCalledWith(3, [0.5, 0.6]);
    const bodyCalls = vi.mocked(textures.body).mock.calls;
    expect(bodyCalls).toHaveLength(2);
    const distortion = bodyCalls[0]?.[0];
    const primary = bodyCalls[1]?.[0];
    for (const [index, expected] of [630.12, 179.94, 375].entries())
      expect(distortion?.[index]).toBeCloseTo(expected, 8);
    for (const [index, expected] of [43.6177, 13.4062, 45.45502].entries())
      expect(primary?.[index]).toBeCloseTo(expected, 8);
    expect(c4[0]).toBeCloseTo(0.604625, 12);
    expect(c4[1]).toBeCloseTo(0.6, 12);
    expect(c4[2]).toBeCloseTo(0.3, 12);
    expect(c4[3]).toBeCloseTo(0.04, 12);
    const result = evaluateReferenceMedium(point, controls, c4);
    expect(result.extinctionPerMeter).toBeCloseTo(0.000208625, 12);
    expect(result.albedo).toEqual([0.9, 0.8, 0.7]);
    expect(result.materialAO).toBe(0.6);
  });

  it('keeps layout, mask, profile, body, erosion, and signed coverage independently observable', () => {
    const textures: ReferenceCloudTextures = {
      ...testTextures(),
      profile: () => [0.5, 0.77, 0.55, 1],
    };
    const density = (c: CloudDensityControls, detail: boolean) =>
      evaluateReferenceMedium(point, c, evaluateReferenceConservative(point, c, textures, detail))
        .extinctionPerMeter;
    const baseline = density(controls, true);
    for (const field of [
      'layoutWeight',
      'maskWeight',
      'profileWeight',
      'bodyWeight',
      'erosionWeight',
    ] as const) {
      expect(density({ ...controls, [field]: 0 }, true)).not.toBeCloseTo(baseline, 10);
    }
    expect(density({ ...controls, coverageBias: 0.2 }, false)).toBeGreaterThan(
      density(controls, false),
    );
    expect(density(controls, true)).not.toBeCloseTo(density(controls, false), 10);
  });

  it('never drops a mask-only sample and agrees with full evaluation where the C4 gate rejects', () => {
    const textures = { ...testTextures(), pattern: () => [0, 0, 0, 1] as const };
    const occupied = evaluateReferenceConservative(point, controls, textures, true);
    expect(occupied[0]).toBeGreaterThan(0);
    expect(evaluateReferenceMedium(point, controls, occupied).extinctionPerMeter).toBeCloseTo(
      0.000004625,
      12,
    );
    const emptyControls = { ...controls, maskWeight: 0, coverageBias: 1 };
    const empty = evaluateReferenceConservative(point, emptyControls, textures, false);
    expect(empty[0]).toBe(0);
    const full = evaluateReferenceMedium(point, emptyControls, empty);
    expect(full.extinctionPerMeter).toBe(0);
    expect(full.emissivePerMeter).toEqual([0, 0, 0]);
  });

  it('applies the height gate and camera-relative meter fade independently', () => {
    const textures = testTextures();
    for (const heightFraction of [-0.01, 0, 0.019, 0.981, 1, 1.01]) {
      const outside = { ...point, heightFraction };
      const outsideC4 = evaluateReferenceConservative(outside, controls, textures, false);
      expect(outsideC4[0]).toBeGreaterThan(0);
      expect(evaluateReferenceMedium(outside, controls, outsideC4).extinctionPerMeter).toBe(0);
    }
    expect(
      evaluateReferenceConservative(
        { ...point, heightFraction: Number.NaN },
        controls,
        textures,
        false,
      ),
    ).toEqual([0, 0, 0, 0]);
    const c4 = evaluateReferenceConservative(point, controls, textures, false);
    const near = { ...point, cameraRelativeMeters: [150, 0, 200] as const };
    const far = { ...point, cameraRelativeMeters: [300, 0, 400] as const };
    expect(evaluateReferenceMedium(near, controls, c4).extinctionPerMeter).toBeCloseTo(
      evaluateReferenceMedium(far, controls, c4).extinctionPerMeter * 0.5,
      14,
    );
  });
});
