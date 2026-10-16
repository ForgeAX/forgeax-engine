import { describe, expect, it } from 'vitest';
import { runGpuDrivenIndirectRasterEvidence } from './gpu-driven-indirect-raster-evidence';

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

describe.skipIf(!browserReady)('GPU-driven indirect raster Browser WebGPU', () => {
  it('consumes indexed, non-indexed, and multi-submesh indirect args without CPU readback', async () => {
    const evidence = await runGpuDrivenIndirectRasterEvidence();
    expect(evidence.passNames).toEqual(
      expect.arrayContaining([
        'gpu-driven.view-reset',
        'gpu-driven.frustum-compact',
        'gpu-driven.finalize-indirect',
        'gpu-driven.lod-selection-readback',
        'gpu-driven.opaque-indirect',
        'gpu-driven.raster-readback',
      ]),
    );
    expect(evidence.pixel).toEqual([64, 128, 191, 255]);
  });
});
