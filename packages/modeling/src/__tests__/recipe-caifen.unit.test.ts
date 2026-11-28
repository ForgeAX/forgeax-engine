import { describe, expect, it } from 'vitest';
import { CAI_GRADES, CUN_METERS, caiFen } from '../recipes/caifen';

describe('caiFen', () => {
  it.each(
    Object.keys(CAI_GRADES).map(Number),
  )('grade %i: width over 15 fen equals depth over 10 fen', (grade) => {
    const r = caiFen(grade);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { fen, width, depth, zuCai } = r.value;
    expect(width / 15).toBeCloseTo(fen, 12);
    expect(depth / 10).toBeCloseTo(fen, 12);
    expect(zuCai).toBeCloseTo(21 * fen, 12);
  });

  it('grade 1 gives 9 cun by 6 cun in meters', () => {
    const r = caiFen(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.width).toBeCloseTo(9 * CUN_METERS, 12);
    expect(r.value.depth).toBeCloseTo(6 * CUN_METERS, 12);
  });

  it.each([0, 9, 1.5, Number.NaN])('refuses grade %s with a structured argument error', (grade) => {
    const r = caiFen(grade);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
  });
});
