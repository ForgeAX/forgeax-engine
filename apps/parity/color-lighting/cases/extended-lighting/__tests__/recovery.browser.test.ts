import { describe, expect, it } from 'vitest';
import { EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES } from '@forgeax/engine-render/internal';
import fixture from '../recovery.json' with { type: 'json' };
import { validateSceneCase } from '../../../src/contracts/validate-scene-case';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { runExtendedLightingCarrier } from '../../../src/compare/extended-case-carrier';
import type { SceneCase } from '../../../src/contracts/types';

describe('extended-lighting recovery browser carrier', () => {
  // Includes initialization plus three complete device rebuilds on software WebGPU.
  it('rebuilds the live Browser carrier through three device generations', async () => {
    const validation = validateSceneCase(fixture);
    expect(validation.ok).toBe(true);
    expect(navigator.gpu).toBeDefined();
    const adapter = await navigator.gpu?.requestAdapter();
    const adapterSupportsExtendedLighting =
      (adapter?.limits.maxSampledTexturesPerShaderStage ?? 0) >=
      EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES;
    const receipt = await runExtendedLightingCarrier({
      fixture: fixture as unknown as SceneCase,
      exactProductHead: 'browser-exact-head',
      bundler: forgeaxBundlerAdapter() as never,
    });
    if (adapterSupportsExtendedLighting) {
      expect(receipt.status).toBe('recovered');
      expect(receipt.capability.admitted).toBe(true);
      expect(receipt.capability.maxSampledTexturesPerShaderStage).toBeGreaterThanOrEqual(
        EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES,
      );
    }
    if (receipt.status === 'unsupported') {
      expect(receipt.verdict).toBe('notRun');
      expect(receipt.capability.admitted).toBe(false);
      expect(receipt.unavailable?.topology).toBe('extendedLighting');
      expect(receipt.unavailable?.reason).toBe(receipt.capability.reason);
      return;
    }
    expect(receipt).toMatchObject({ caseId: 'recovery', status: 'recovered', verdict: 'passed' });
    expect(receipt.recovery?.cycles).toBe(3);
    expect(receipt.recovery?.generations).toHaveLength(4);
    expect(receipt.recovery?.terminalState).toBe('alive');
    expect(new Set(receipt.recovery?.generations).size).toBe(4);
    expect(receipt.recovery?.resourceCounts.every((count) => count <= (receipt.recovery?.resourceCounts[0] ?? 0))).toBe(true);
    expect(receipt.finalDisplay.nonBlackPixels).toBeGreaterThan(0);
  }, 90_000);
});
