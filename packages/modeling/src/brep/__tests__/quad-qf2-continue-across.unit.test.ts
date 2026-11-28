import { describe, expect, it } from 'vitest';
import { filletBox } from '../fillet-box';
import { quadrangulate } from '../quad';
import { g1RowContinuity } from '../quad-g1-metric';

// Diagnosis gate for continue-across (see knowledge/notes/qf2-continue-across-diagnosis.md).
// No generator consumes the constraint yet; these pin the measured baseline and the open target.
const fraction = (size: number): number => {
  const shape = filletBox({ size: [4, 3, 2], radius: 0.5 });
  if (!shape.ok) throw new Error('filletBox failed');
  const r = quadrangulate(shape.value, { size, trimmed: 'quad-dominant' });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const g = g1RowContinuity(shape.value, r.value);
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  return g.value.fraction;
};

describe('continue-across baseline (no consumer yet)', () => {
  it('floor: G1 fraction at size 0.5 stays at the measured 0.8333', () => {
    expect(fraction(0.5)).toBeGreaterThanOrEqual(0.83);
  });

  it.fails('target: G1 fraction at size 0.5 reaches 1.0 once a generator consumes continue-across', () => {
    expect(fraction(0.5)).toBe(1);
  });
});
