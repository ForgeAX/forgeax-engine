import { describe, expect, it } from 'vitest';
import { createForgeaxAdapter } from '../../../src/adapters/forgeax-adapter';
import { createThreeAdapter } from '../../../src/adapters/three-adapter';
import { runParityMatrix } from '../../../src/cli/run-parity';
import type { CaptureConfig } from '../../../src/capture/named-capture';
import type { SceneCase } from '../../../src/contracts/types';

const sceneCase: SceneCase = {
  caseId: 'tone-output-boundary',
  required: true,
  colorDomain: 'displayEncoded',
  scene: { width: 1, height: 1, background: [0, 0, 0, 0] },
  budget: { analyticMax: 0, roiMax: 0, byteMax: 0 },
};

function captureConfig(colorDomain: CaptureConfig['colorDomain']): CaptureConfig {
  return { width: 1, height: 1, colorDomain, background: [0, 0, 0, 0] };
}

describe('tone output boundary case', () => {
  it('reports linear and final captures as separate domains', async () => {
    const forgeax = createForgeaxAdapter(async () => ({
      linear: [0.25, 1, 4, 1],
      final: [128, 255, 255, 255],
      config: captureConfig('displayEncoded'),
    }));
    const three = createThreeAdapter(async () => ({
      linear: [0.25, 1, 4, 1],
      final: [128, 255, 255, 255],
      config: captureConfig('displayEncoded'),
    }));

    const result = await runParityMatrix([sceneCase], forgeax, three);
    expect(result.ok).toBe(true);
    const report = result.cases[0]?.report;
    expect(report?.captures.forgeax.linear).toEqual([0.25, 1, 4, 1]);
    expect(report?.captures.forgeax.final).toEqual([128, 255, 255, 255]);
    expect(report?.metrics).toEqual({ analyticMax: 0, roiMax: 0, differingBytes: 0 });
  });

  it('preserves a linear capture mismatch separately from final metrics', async () => {
    const forgeax = createForgeaxAdapter(async () => ({
      linear: [0.25, 1, 4, 1],
      final: [128, 255, 255, 255],
      config: captureConfig('displayEncoded'),
    }));
    const three = createThreeAdapter(async () => ({
      linear: [0.5, 1, 4, 1],
      final: [128, 255, 255, 255],
      config: captureConfig('displayEncoded'),
    }));

    const result = await runParityMatrix([sceneCase], forgeax, three);
    expect(result.ok).toBe(true);
    expect(result.cases[0]?.report.captures.three.linear).toEqual([0.5, 1, 4, 1]);
    expect(result.cases[0]?.report.captures.three.final).toEqual([128, 255, 255, 255]);
    expect(result.cases[0]?.report.metrics).toEqual({ analyticMax: 0, roiMax: 0, differingBytes: 0 });
  });
});
