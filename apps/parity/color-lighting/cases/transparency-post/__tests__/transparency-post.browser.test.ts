import { describe, expect, it } from 'vitest';
import ldrCase from '../transparent-ldr-urp.json' with { type: 'json' };
import hdrCase from '../transparent-hdr-hdrp.json' with { type: 'json' };
import { createForgeaxAdapter } from '../../../src/adapters/forgeax-adapter';
import { createThreeAdapter } from '../../../src/adapters/three-adapter';
import { runParityMatrix } from '../../../src/cli/run-parity';
import type { SceneCase } from '../../../src/contracts/types';
import { captureForgeaxBrowser, captureThreeBrowser } from '../gpu-capture';

const cases = [ldrCase, hdrCase] as unknown as readonly SceneCase[];

describe('transparency post browser GPU parity', () => {
  it('captures paired URP LDR and HDRP HDR transparent PBR cases', async () => {
    const result = await runParityMatrix(
      cases,
      createForgeaxAdapter(captureForgeaxBrowser),
      createThreeAdapter(captureThreeBrowser, 'webgpu'),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.cases.map((entry) => entry.report.caseId)).toEqual([
      'transparent-ldr-urp',
      'transparent-hdr-hdrp',
    ]);
    for (const entry of result.cases) {
      expect(entry.report.provenance.forgeax.adapterId).toBe('forgeax-webgpu');
      expect(entry.report.provenance.three.adapterId).toBe('three-r184-webgpu');
      expect(entry.report.metrics.analyticMax).toBeLessThanOrEqual(entry.report.budget.analyticMax);
      expect(entry.report.metrics.roiMax).toBeLessThanOrEqual(entry.report.budget.roiMax);
    }
  }, 120_000);
});
