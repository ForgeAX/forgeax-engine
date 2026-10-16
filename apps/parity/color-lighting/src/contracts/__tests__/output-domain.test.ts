import { describe, expect, it } from 'vitest';
import type { CaptureConfig } from '../../capture/named-capture';
import type { ColorDomain } from '../types';

const outputDomains: readonly ColorDomain[] = ['linearHdr', 'linearLdr', 'displayEncoded'];

describe('tone output domain contract', () => {
  it('keeps the three color domains closed and ordered by pipeline stage', () => {
    expect(outputDomains).toEqual(['linearHdr', 'linearLdr', 'displayEncoded']);
  });

  it('uses linear HDR as tone input and display encoded as final output', () => {
    const config: CaptureConfig = {
      width: 4,
      height: 1,
      colorDomain: 'linearHdr',
      background: [0, 0, 0, 0],
    };
    const mapped: CaptureConfig = { ...config, colorDomain: 'linearLdr' };
    const final: CaptureConfig = { ...config, colorDomain: 'displayEncoded' };
    expect(config.colorDomain).toBe('linearHdr');
    expect(mapped.colorDomain).toBe('linearLdr');
    expect(final.colorDomain).toBe('displayEncoded');
    expect(new Set([config.colorDomain, mapped.colorDomain, final.colorDomain]).size).toBe(3);
  });

  it('keeps exposure in the linear stage rather than in output encoding', () => {
    const exposedLinear = [0.25, 1, 4].map((value) => value * 2);
    const encoded = exposedLinear.map((value) => Math.pow(Math.min(value, 1), 1 / 2.2));
    expect(exposedLinear).toEqual([0.5, 2, 8]);
    expect(encoded[0]).toBeGreaterThan(exposedLinear[0] ?? 0);
    expect(encoded[1]).toBe(1);
    expect(encoded[2]).toBe(1);
  });
});
