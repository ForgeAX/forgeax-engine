import { describe, expect, it } from 'vitest';
import { runStandardLutReadback } from './standard-output-gpu-evidence';

describe('Standard output LUT readback in Chromium', () => {
  it('samples an ordinary 3D LUT and performs one final sRGB encoding', async () => {
    const evidence = await runStandardLutReadback();
    expect(evidence.backend).toBe('webgpu');
    expect(evidence.linearHdr[0]).toBeCloseTo(0.292, 2);
    expect(evidence.linearLdr[3]).toBeCloseTo(0.7, 3);
    expect(evidence.finalSrgb[0]).toBeGreaterThan(140);
    expect(evidence.finalSrgb[3]).toBeGreaterThan(170);
    expect(evidence.singleOetf).toBe(true);
    expect(evidence.lkgRecovery).toBe('preserved');
  });
});
