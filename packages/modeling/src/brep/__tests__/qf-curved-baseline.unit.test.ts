import { describe, expect, it } from 'vitest';
import { CURVED_CASES } from '../../../examples/qf-curved-baseline/shapes';
import { faceLoops } from '../faces';
import { quadrangulate } from '../quad';
import { validate } from '../validate';

// M-QF3 baseline gate: the curved holed solids are valid closed B-reps, and without the opt-in every trimmed mode fails
// closed on their holed curved face with `trimmed-loop`. The opt-in iso layout is gated in quad-iso-quadric.unit.test.ts.
describe('curved holed baseline solids', () => {
  for (const c of CURVED_CASES) {
    const built = c.build();

    it(`${c.name} builds as a valid closed solid with a holed curved face`, () => {
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const report = validate(built.value);
      expect(report.ok).toBe(true);
      const holed = built.value.faces
        .map((_, f) => f)
        .filter((f) => faceLoops(built.value, f).holes.length > 0);
      expect(holed.length).toBeGreaterThan(0);
      for (const f of holed) {
        const surface = built.value.surfaces[built.value.faces[f]?.surface as number];
        expect(surface?.kind).not.toBe('plane');
      }
    });

    for (const trimmed of ['reject', 'blossom', 'blossom-row'] as const) {
      it(`${c.name} fails closed in ${trimmed} mode with detail.reason trimmed-loop`, () => {
        if (!built.ok) throw new Error('build failed');
        const r = quadrangulate(built.value, { size: 0.25, trimmed });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe('model-partial');
        expect((r.error.detail as { reason?: string }).reason).toBe('trimmed-loop');
      });
    }
  }
});
