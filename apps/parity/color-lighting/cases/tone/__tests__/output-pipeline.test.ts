import { describe, expect, it } from 'vitest';
import { resolveToneOutputContract } from '@forgeax/engine-render';

describe('tone output pipeline', () => {
  it('routes every public tone mode through the HDR to LDR boundary', () => {
    for (const mode of ['linear', 'reinhard', 'cineon', 'aces-filmic', 'agx', 'neutral'] as const) {
      expect(resolveToneOutputContract(mode)).toEqual({
        input: 'linearHdr',
        toneMapped: true,
        mapped: 'linearLdr',
        finalCapture: 'displayEncoded',
        exposureStage: 'linearHdr',
      });
    }
  });

  it('keeps the no-tone path on the LDR surface', () => {
    expect(resolveToneOutputContract('none')).toEqual({
      input: 'linearLdr',
      toneMapped: false,
      mapped: 'linearLdr',
      finalCapture: 'displayEncoded',
      exposureStage: 'none',
    });
  });
});
