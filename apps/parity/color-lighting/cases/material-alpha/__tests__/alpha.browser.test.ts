import { afterEach, describe, expect, it } from 'vitest';
import { captureThree } from '../../../src/main';

interface AlphaCaptureDiagnostics {
  readonly caseId: string;
  readonly centerRgba?: readonly number[];
  readonly linearHdr?: { readonly nonZeroBytes: number };
  readonly error?: string;
}

declare global {
  interface Window {
    __colorLightingParitySingle?: (caseId: string) => Promise<AlphaCaptureDiagnostics>;
  }
}

const REQUIRED_ALPHA_CASE_IDS = [
  'material-alpha-rgba-factor',
  'material-alpha-mask-default',
  'material-alpha-mask-explicit',
  'material-alpha-mask-zero',
  'material-alpha-mask-one',
  'material-alpha-mask-equal',
  'material-alpha-blend',
] as const;

const explicitCase = {
  caseId: 'material-alpha-mask-explicit',
  required: true,
  colorDomain: 'linearLdr',
  scene: { width: 4, height: 4, background: [0, 0, 0, 0] },
  comparison: { primaryMetric: 'occupancy' },
  budget: { analyticMax: 0.01, roiMax: 0.01, byteMax: 0 },
  alpha: { mode: 'MASK', baseAlpha: 0.6, cutoff: 0.25 },
  baseColor: [1, 1, 1, 1],
} as const;

function assertVisibleCenter(center: readonly number[] | undefined): void {
  expect(center).toHaveLength(4);
  expect(center?.slice(0, 3).some((channel) => channel > 0)).toBe(true);
  expect(center?.[3]).toBeGreaterThan(0);
}

function centerOf(pixels: readonly number[], width: number, height: number): readonly number[] {
  const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  return pixels.slice(offset, offset + 4);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('material alpha browser final-display readback', () => {
  it('keeps the explicit MASK frame visible through ForgeaX and Three', async () => {
    document.body.innerHTML = '<canvas id="forgeax"></canvas><canvas id="three"></canvas>';
    const forgeax = await window.__colorLightingParitySingle?.(explicitCase.caseId);
    expect(forgeax?.error).toBeUndefined();
    expect(forgeax?.linearHdr?.nonZeroBytes).toBeGreaterThan(0);
    assertVisibleCenter(forgeax?.centerRgba);
    const three = await captureThree(explicitCase as never, 'webgpu');
    assertVisibleCenter(centerOf(three.final, explicitCase.scene.width, explicitCase.scene.height));
  }, 120_000);

  it('closes all seven required alpha cases through the focused real-browser seam', async () => {
    document.body.innerHTML = '<canvas id="forgeax"></canvas><canvas id="three"></canvas>';
    for (const caseId of REQUIRED_ALPHA_CASE_IDS) {
      const capture = await window.__colorLightingParitySingle?.(caseId);
      expect(capture?.error, `${caseId} browser capture`).toBeUndefined();
    }
  }, 120_000);
});
