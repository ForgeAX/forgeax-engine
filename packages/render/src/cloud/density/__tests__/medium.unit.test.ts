import { describe, expect, it } from 'vitest';
import type { MediumSample } from '../../contracts';
import {
  cloudAdvectedModelPosition,
  cloudDistanceFade,
  cloudHeightFraction,
  cloudModelPosition,
  cloudRelativePosition,
  evaluateUniformConservative,
  evaluateUniformMedium,
} from '../medium';
import { uniformTransmittance } from '../reference-model';

const uniform: MediumSample = {
  extinctionPerMeter: Math.LN2 / 1000,
  albedo: [0, 0.4, 1],
  emissivePerMeter: [0, 0, 0],
  materialAO: 0.3,
};

describe('uniform cloud medium', () => {
  it('preserves validated albedo and AO at both layer boundaries and within the layer', () => {
    for (const h of [0, 0.3, 1]) {
      expect(evaluateUniformConservative(uniform, h)).toEqual([1, 0, 0, 0]);
      expect(evaluateUniformMedium(uniform, h)).toEqual(uniform);
    }
    expect(
      uniformTransmittance(evaluateUniformMedium(uniform, 0.5).extinctionPerMeter, 2000),
    ).toBeCloseTo(0.25, 14);
  });

  it('reports vacuum without mutating the validated sample when the layer cannot contain it', () => {
    const frozen = Object.freeze(uniform);
    for (const h of [-Number.EPSILON, 1 + Number.EPSILON, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluateUniformConservative(frozen, h)).toEqual([0, 0, 0, 0]);
      expect(evaluateUniformMedium(frozen, h)).toEqual({
        extinctionPerMeter: 0,
        albedo: [0, 0, 0],
        emissivePerMeter: [0, 0, 0],
        materialAO: 1,
      });
    }
    expect(evaluateUniformMedium(frozen, 0.5)).toEqual(uniform);
  });

  it('skips vacuum but cannot skip a purely emissive uniform medium', () => {
    const transparent = { ...uniform, extinctionPerMeter: 0 };
    expect(evaluateUniformConservative(transparent, 0.5)).toEqual([0, 0, 0, 0]);
    expect(uniformTransmittance(transparent.extinctionPerMeter, 350_000)).toBe(1);
    const emissive: MediumSample = { ...transparent, emissivePerMeter: [0, 0.001, 0] };
    expect(evaluateUniformConservative(emissive, 0.5)).toEqual([1, 0, 0, 0]);
    expect(evaluateUniformMedium(emissive, 0.5)).toEqual(emissive);
  });
});

describe('cloud sample coordinates', () => {
  it('keeps meter lengths and the source graph axis convention', () => {
    expect(cloudRelativePosition([10_010, 5005, 29], [10_000, 5, 50])).toEqual([10, 5000, -21]);
    expect(cloudModelPosition([10, 5000, -21])).toEqual([21, 10, 5000]);
    expect(cloudHeightFraction(4500, 5000, 2000)).toBe(-0.25);
    expect(cloudHeightFraction(5000, 5000, 2000)).toBe(0);
    expect(cloudHeightFraction(6500, 5000, 2000)).toBe(0.75);
    expect(cloudHeightFraction(7000, 5000, 2000)).toBe(1);
    expect(cloudHeightFraction(7500, 5000, 2000)).toBe(1.25);
  });

  it('uses meter distance for fade and samples opposite the wind displacement', () => {
    expect(cloudDistanceFade([0, 0, 0])).toBe(0);
    expect(cloudDistanceFade([150, 0, 200])).toBeCloseTo(0.5, 14);
    expect(cloudDistanceFade([300, 0, 400])).toBe(1);
    expect(cloudDistanceFade([1000, 0, 0])).toBe(1);
    expect(cloudAdvectedModelPosition([24, 5, -8], [2, 0, 1], 0)).toEqual([8, 24, 5]);
    expect(cloudAdvectedModelPosition([24, 5, -8], [2, 0, 1], 3)).toEqual([11, 18, 5]);
  });
});
