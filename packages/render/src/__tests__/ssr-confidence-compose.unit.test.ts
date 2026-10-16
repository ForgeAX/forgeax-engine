import { describe, expect, it } from 'vitest';
import { composeSsrReflection } from '../ssr/composition';
import { buildSsrTracePlan } from '../ssr/graph';

const baseSpecular = [0.2, 0.3, 0.4] as const;
const screenSpecular = [0.8, 0.7, 0.9] as const;
const fallbackSpecular = [0.1, 0.2, 0.3] as const;

describe('SSR spatial confidence and composition contract', () => {
  it('keeps the Standard lobe unchanged at zero and replaces only its fallback delta at one', () => {
    expect(
      composeSsrReflection({ c: 0, baseSpecular, screenSpecular, fallbackSpecular }),
    ).toMatchObject({ ok: true, value: baseSpecular });
    const full = composeSsrReflection({
      c: 1,
      baseSpecular,
      screenSpecular,
      fallbackSpecular,
    });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.value[0]).toBeCloseTo(0.9, 12);
      expect(full.value[1]).toBeCloseTo(0.8, 12);
      expect(full.value[2]).toBeCloseTo(1, 12);
    }
    const half = composeSsrReflection({
      c: 0.5,
      baseSpecular,
      screenSpecular,
      fallbackSpecular,
    });
    expect(half.ok).toBe(true);
    if (half.ok) {
      expect(half.value[0]).toBeCloseTo(0.55, 12);
      expect(half.value[1]).toBeCloseTo(0.55, 12);
      expect(half.value[2]).toBeCloseTo(0.7, 12);
    }
  });

  it('keeps trace work bounded and explicitly half-resolution', () => {
    expect(buildSsrTracePlan()).toEqual({
      resolution: 'half',
      coarseSteps: 48,
      refineSteps: 5,
    });
  });
});
