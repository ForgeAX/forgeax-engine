import { describe, expect, it } from 'vitest';
import { composeSsrReflection } from '../ssr/composition';

const baseSpecular = [0.2, 0.3, 0.4] as const;
const screenSpecular = [0.8, 0.7, 0.9] as const;
const fallbackSpecular = [0.1, 0.2, 0.3] as const;

describe('SSR M0 reflection composition', () => {
  it('keeps the base specular lobe when c=0', () => {
    const composed = composeSsrReflection({
      c: 0,
      baseSpecular,
      screenSpecular,
      fallbackSpecular,
    });
    expect(composed).toMatchObject({ ok: true, value: baseSpecular });
  });

  it('replaces only the same-source lobe when c=1', () => {
    const composed = composeSsrReflection({
      c: 1,
      baseSpecular,
      screenSpecular,
      fallbackSpecular,
    });
    expect(composed.ok).toBe(true);
    if (composed.ok) {
      expect(composed.value[0]).toBeCloseTo(0.9, 12);
      expect(composed.value[1]).toBeCloseTo(0.8, 12);
      expect(composed.value[2]).toBeCloseTo(1, 12);
    }
  });

  it('rejects an unbounded confidence instead of clamping an invalid contract', () => {
    const composed = composeSsrReflection({
      c: 1.01,
      baseSpecular,
      screenSpecular,
      fallbackSpecular,
    });
    expect(composed).toMatchObject({
      ok: false,
      error: { code: 'ssr-composition-input-invalid', detail: { field: 'c' } },
    });
  });
});
