import { describe, expect, it } from 'vitest';
import type { CaptureConfig, CaptureEnvelope } from '../../capture/named-capture';
import type { SceneCase } from '../../contracts/types';
import { createForgeaxAdapter } from '../../adapters/forgeax-adapter';
import { createThreeAdapter } from '../../adapters/three-adapter';
import { runParityMatrix } from '../../cli/run-parity';
import falsificationManifest from '../../../cases/default/falsification/manifest.json' with { type: 'json' };

const cases = falsificationManifest.cases.map(
  (entry) => ({
    caseId: entry.caseId,
    required: falsificationManifest.required,
    colorDomain: falsificationManifest.colorDomain,
    scene: falsificationManifest.scene,
    budget: falsificationManifest.budget,
  }) as unknown as SceneCase,
);

const config: CaptureConfig = {
  width: falsificationManifest.scene.width,
  height: falsificationManifest.scene.height,
  colorDomain: falsificationManifest.colorDomain as SceneCase['colorDomain'],
  background: falsificationManifest.scene.background,
};

const baseCapture = {
  linear: [0.2140411405, 0.0508760882, 0.6038273389, 0],
  final: [128, 64, 200, 255],
  config,
};

function mutateFinal(capture: CaptureEnvelope, mutation: string): CaptureEnvelope {
  const final = [...capture.captures.final];
  if (mutation === 'reverse-clear-alpha') final[3] = 0;
  if (mutation === 'flat-color-substitution') final.splice(0, final.length, 0, 0, 0, 0);
  if (mutation === 'repeated-decode') final[0] = 55;
  if (mutation === 'omitted-decode') final[0] = 188;
  return { ...capture, captures: { ...capture.captures, final } };
}

function fixtureMutation(caseId: string): string {
  const fixture = falsificationManifest.cases.find((entry) => entry.caseId === caseId);
  if (fixture === undefined) throw new Error(`missing falsification fixture: ${caseId}`);
  return fixture.mutation;
}

describe('M1 falsification capture provenance', () => {
  it('fails every mutation with non-zero numeric evidence and linked artifacts', async () => {
    const forgeax = createForgeaxAdapter(async () => baseCapture);
    const three = createThreeAdapter(async () => baseCapture, 'webgpu');
    const result = await runParityMatrix(cases, forgeax, three, {
      expectedErrors: Object.fromEntries(cases.map((entry) => [entry.caseId, 'budget-exceeded'])),
      mutateThree: Object.fromEntries(
        cases.map((entry) => [entry.caseId, (capture: CaptureEnvelope) => mutateFinal(capture, fixtureMutation(entry.caseId))]),
      ),
    });

    expect(result.ok).toBe(true);
    for (const caseResult of result.cases) {
      expect(caseResult.passed).toBe(true);
      expect(caseResult.errorCode).toBe('budget-exceeded');
      expect(caseResult.report.metrics.differingBytes).toBeGreaterThan(0);
      expect(caseResult.report.provenance.forgeax.adapterId).toBe('forgeax-webgpu');
      expect(caseResult.report.provenance.three.adapterId).toBe('three-r184-webgpu');
      expect(falsificationManifest.artifacts).toEqual([
        'forgeax-final',
        'three-primary-final',
        'diff-roi',
      ]);
    }
  });
});
