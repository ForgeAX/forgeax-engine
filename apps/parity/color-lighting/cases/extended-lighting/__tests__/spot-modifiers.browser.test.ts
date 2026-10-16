import { describe, expect, it } from 'vitest';
import fixture from '../spot-modifiers.json' with { type: 'json' };
import { validateSceneCase } from '../../../src/contracts/validate-scene-case';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  runExtendedLightingCarrier,
  runExtendedLightingCookieContrast,
} from '../../../src/compare/extended-case-carrier';
import type { SceneCase } from '../../../src/contracts/types';

describe('extended-lighting Spot browser carrier', () => {
  it('validates the authored fixture before the browser consumer starts', () => {
    const result = validateSceneCase(fixture);
    expect(result.ok).toBe(true);
    expect(fixture.extendedLighting?.topology).toBe('extendedLighting');
    expect(fixture.light?.kind).toBe('spot');
    expect(fixture.extendedLighting?.iesSliceCount).toBe(1);
    expect(fixture.extendedLighting?.cookieSliceCount).toBe(1);
  });

  it('renders IES, Cookie, and shadow in one live Browser Spot comparison', async () => {
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
    expect(receipt).toMatchObject({ caseId: 'spot-modifiers', status: 'ready', verdict: 'passed' });
    expect(receipt.referenceKinds).toEqual(['three-r184-native-webgpu-spot-ies-cookie-shadow-combined']);
    expect(receipt.referenceProvenance).toEqual(expect.arrayContaining([
      'three-r184-ies-spot-light',
      'three-r184-webgpu-spot-light-map',
      'three-r184-webgpu-spot-shadow',
    ]));
    expect(receipt.inspection.extendedLighting.resourceCount).toBeGreaterThan(0);
    expect(receipt.finalDisplay.nonBlackPixels).toBeGreaterThan(0);
  }, 60_000);

  // A contended lavapipe runner can spend >15s in the first live cookie
  // replacement while the assertion remains the same fail-closed check.
  it('changes the live Browser pixels when the Cookie texture changes', async () => {
    expect(navigator.gpu).toBeDefined();
    const receipt = await runExtendedLightingCookieContrast({
      fixture: fixture as unknown as SceneCase,
      exactProductHead: 'browser-exact-head',
      bundler: forgeaxBundlerAdapter() as never,
    });
    if (receipt.status === 'unsupported') {
      expect(receipt.reason).toBeTruthy();
      return;
    }
    expect(receipt.maxChannelDelta).toBeGreaterThan(8);
    expect(receipt.changedPixels).toBeGreaterThan(receipt.pixelCount * 0.02);
  }, 60_000);
});
