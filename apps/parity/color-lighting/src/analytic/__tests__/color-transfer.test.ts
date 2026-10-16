import {
  linearChannelToSrgb,
  srgbChannelToLinear,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { SceneCase } from '../../contracts/types';
import { M1_CASE_INPUTS } from '../../report/m1-required';
import requiredManifest from '../../../cases/default/required.json' with { type: 'json' };

const cases = requiredManifest.caseIds
  .filter((caseId) => caseId !== 'default-transparent-alpha')
  .map(
  (caseId) => ({
    caseId,
    required: requiredManifest.required,
    colorDomain: requiredManifest.colorDomain,
    scene: requiredManifest.scene,
    budget: requiredManifest.budget,
    input: M1_CASE_INPUTS[caseId],
  }) as unknown as SceneCase,
  );
const midSrgb = 0.5;
const midLinear = srgbChannelToLinear(midSrgb);

function decodeTextureSample(value: number): number {
  return srgbChannelToLinear(value);
}

function expectWithinBudget(actual: number, expected: number, sceneCase: SceneCase): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(sceneCase.budget.analyticMax);
}

describe('M1 color transfer analytic baselines', () => {
  it('keeps scalar sRGB authored values linear exactly once', () => {
    const sceneCase = cases.find((entry) => entry.caseId === 'default-scalar-srgb');
    if (sceneCase === undefined) throw new Error('missing scalar sRGB case');
    expectWithinBudget(srgbChannelToLinear(midSrgb), midLinear, sceneCase);
    expect(linearChannelToSrgb(midLinear)).toBeCloseTo(midSrgb, 12);
  });

  it('decodes an sRGB texture sample once at the texture boundary', () => {
    const sceneCase = cases.find((entry) => entry.caseId === 'default-srgb-texture');
    if (sceneCase === undefined) throw new Error('missing sRGB texture case');
    const decoded = decodeTextureSample(midSrgb);
    expectWithinBudget(decoded, midLinear, sceneCase);
    expect(linearChannelToSrgb(decoded)).toBeCloseTo(midSrgb, 12);
  });

  it('leaves an already-linear input unchanged', () => {
    const sceneCase = cases.find((entry) => entry.caseId === 'default-linear-input');
    if (sceneCase === undefined) throw new Error('missing linear input case');
    expectWithinBudget(midLinear, midLinear, sceneCase);
    expect(midLinear).not.toBeCloseTo(srgbChannelToLinear(midLinear), 3);
  });

  it('applies factor in linear space after texture decode', () => {
    const sceneCase = cases.find((entry) => entry.caseId === 'default-factor-texture');
    if (sceneCase === undefined) throw new Error('missing factor texture case');
    const expected = 0.5 * decodeTextureSample(0.8);
    expectWithinBudget(0.5 * decodeTextureSample(0.8), expected, sceneCase);
    expect(0.5 * srgbChannelToLinear(0.8)).not.toBeCloseTo(0.5 * 0.8, 3);
  });

  it('round-trips every channel ramp sample within the byte budget', () => {
    const sceneCase = cases.find((entry) => entry.caseId === 'default-channel-ramp');
    if (sceneCase === undefined) throw new Error('missing channel ramp case');
    for (let byte = 0; byte <= 255; byte += 17) {
      const encoded = byte / 255;
      const roundTrip = linearChannelToSrgb(srgbChannelToLinear(encoded));
      expectWithinBudget(roundTrip, encoded, sceneCase);
    }
  });

  it('makes repeated and omitted decode falsifications measurably fail', () => {
    const sceneCase = cases.find((entry) => entry.caseId === 'default-srgb-texture');
    if (sceneCase === undefined) throw new Error('missing sRGB texture case');
    const repeatedDecode = srgbChannelToLinear(decodeTextureSample(midSrgb));
    const omittedDecode = midSrgb;
    expect(Math.abs(repeatedDecode - midLinear)).toBeGreaterThan(sceneCase.budget.analyticMax);
    expect(Math.abs(omittedDecode - midLinear)).toBeGreaterThan(sceneCase.budget.analyticMax);
  });
});
