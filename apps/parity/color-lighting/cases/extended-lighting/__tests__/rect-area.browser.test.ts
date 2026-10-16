import { describe, expect, it } from 'vitest';
import fixture from '../rect-area.json' with { type: 'json' };
import falsificationManifest from '../falsification/manifest.json' with { type: 'json' };
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { runExtendedLightingCarrier } from '../../../src/compare/extended-case-carrier';
import type { SceneCase } from '../../../src/contracts/types';

describe('extended-lighting RectArea browser carrier', () => {
  it('validates the Rect carrier fixture and falsifier inputs', () => {
    expect(fixture.caseId).toBe('rect-area');
    expect(fixture.colorDomain).toBe('linearHdr');
    expect(fixture.light.kind).toBe('rect-area');
    expect(fixture.oracle.frontFacing).toBe('axisX-cross-axisY');
    expect(fixture.oracle.brdf).toEqual(['lambert-ltc', 'ggx-ltc']);
    expect(fixture.oracle.shadowTile).toBe('none');
    expect(fixture.oracle.punctualInverseSquare).toBe(false);
    expect(falsificationManifest.cases.filter((entry) => entry.sourceCaseId === 'rect-area').map((entry) => entry.mutation)).toEqual([
      'reverse-front-facing',
      'zero-ltc-tables',
    ]);
  });

  it('compares a live RectArea Browser frame with the Three r184 reference contract', async () => {
    expect(navigator.gpu).toBeDefined();
    const receipt = await runExtendedLightingCarrier({
      fixture: fixture as unknown as SceneCase,
      exactProductHead: 'browser-exact-head',
      bundler: forgeaxBundlerAdapter() as never,
    });
    if (receipt.status === 'unsupported') {
      expect(receipt.verdict).toBe('notRun');
      expect(receipt.capability.admitted).toBe(false);
      expect(receipt.unavailable?.topology).toBe('extendedLighting');
      expect(receipt.unavailable?.reason).toBe(receipt.capability.reason);
      return;
    }
    expect(receipt).toMatchObject({ caseId: 'rect-area', status: 'ready', verdict: 'passed' });
    expect(receipt.referenceKinds).toEqual(['three-r184-native-webgl2-rect-area-plus-finite-range-adapter']);
    expect(receipt.linearHdr).toMatchObject({ format: 'rgba16float', width: 64, height: 64 });
    expect(receipt.linearHdr.byteLength).toBeGreaterThan(0);
    expect(receipt.finalDisplay.nonBlackPixels).toBeGreaterThan(0);
    expect(receipt.inspection.perFramePassNames.length).toBeGreaterThan(0);
  }, 30_000);
});
