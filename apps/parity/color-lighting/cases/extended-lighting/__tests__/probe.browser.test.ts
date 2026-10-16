import { describe, expect, it } from 'vitest';
import fixture from '../probe.json' with { type: 'json' };
import { validateSceneCase } from '../../../src/contracts/validate-scene-case';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { runExtendedLightingCarrier } from '../../../src/compare/extended-case-carrier';
import type { SceneCase } from '../../../src/contracts/types';

describe('extended-lighting Probe browser carrier', () => {
  it('matches live Browser ProbeBlendRecord coverage to the independent finite-volume oracle', async () => {
    const validation = validateSceneCase(fixture);
    expect(validation.ok).toBe(true);
    expect(navigator.gpu).toBeDefined();
    const receipt = await runExtendedLightingCarrier({
      fixture: fixture as unknown as SceneCase,
      exactProductHead: 'browser-exact-head',
      bundler: forgeaxBundlerAdapter() as never,
    });
    expect(receipt).toMatchObject({ caseId: 'probe', status: 'ready', verdict: 'passed' });
    expect(receipt.referenceKinds).toEqual(['three-r184-lightprobe-sh9-not-native-local-volume']);
    expect(receipt.probeComparison).toMatchObject({ recordCount: 9 });
    expect(receipt.probeComparison?.maxDelta).toBeLessThanOrEqual(1e-5);
    expect(receipt.inspection.renderScene.probeBlend?.finite).toBe(true);
    expect(receipt.inspection.renderScene.probeBlend?.skyResidualFraction).toBeGreaterThanOrEqual(0);
    expect(receipt.inspection.renderScene.probeBlend?.skyResidualFraction).toBeLessThanOrEqual(1);
    // ProbeBlend is now carried by the scene-index producer. Keep this
    // assertion receipt-bound so a CPU fallback cannot silently satisfy the
    // independent local-volume oracle.
    expect(receipt.inspection.renderScene.gpuDriven.submitted).toBe(true);
    expect(receipt.inspection.renderScene.gpuDriven.channels).toContainEqual(
      expect.objectContaining({ lane: 'gpu' }),
    );
  }, 60_000);
});
