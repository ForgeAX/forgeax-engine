import { describe, expect, it } from 'vitest';
import { runVisibilityDawnSmoke } from '../scripts/smoke-dawn.mjs';

describe('entity visibility Dawn smoke', () => {
  // CI keeps every visibility/shadow/readback assertion while using a bounded
  // frame window on overloaded lavapipe; the direct smoke CLI remains 60 and
  // the PR profile retains 12 settled frames for every visibility assertion.
  const frameCount = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 12 : 60;
  // The full 60-frame Dawn smoke includes renderer setup and readback. Hosted
  // Windows Dawn cold starts can exceed the project-wide 30 s budget; keep the
  // owner-specific gate bounded at 120 s without changing its assertions.
  const ENTITY_VISIBILITY_DAWN_TEST_TIMEOUT_MS = 120_000;

  it('keeps main, shadow, and visible-child criteria true for the selected frame window', { timeout: ENTITY_VISIBILITY_DAWN_TEST_TIMEOUT_MS, retry: 0 }, async () => {
    const result = await runVisibilityDawnSmoke({ frames: frameCount });
    expect(result.backend).toBe('webgpu');
    expect(result.frames).toBeGreaterThanOrEqual(frameCount);
    expect(result.targetRed.baseline).toBeGreaterThan(80);
    expect(result.targetRed.hidden).toBeLessThan(result.targetRed.baseline * 0.05);
    expect(result.targetRed.restored).toBeGreaterThan(result.targetRed.baseline * 0.8);
    expect(result.childColors.blue).toBeGreaterThan(60);
    expect(result.childColors.gold).toBeGreaterThan(5);
    expect(result.hiddenShadowDelta.changedPixels).toBeGreaterThan(30);
    expect(result.hiddenShadowDelta.meanL1).toBeGreaterThan(5);
    expect(result.restoredShadowDelta.changedPixels).toBeGreaterThan(30);
    expect(result.restoredShadowDelta.meanL1).toBeGreaterThan(5);
    expect(result.hiddenTargetEffective).toBe('hidden');
    expect(result.restoredTargetEffective).toBe('visible');
    expect(result.visibleChildEffective).toBe('visible');
    expect(result.inheritedDescendantEffective).toBe('visible');
    expect(result.errors).toEqual([]);
  });
});
