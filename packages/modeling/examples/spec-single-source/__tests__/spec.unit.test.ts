import { model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildLeg, legDrawing, shin, thigh } from '../body.ts';
import { LEG, legSpec } from '../spec.ts';

/** Heights of a tagged part: [lowest y, highest y]. */
function span(m: ReturnType<typeof buildLeg>, tag: string): [number, number] {
  const b = m.bounds(sel.tag(tag));
  if (!b.ok) throw b.error;
  return [b.value.min[1], b.value.max[1]];
}

/** Drawing findings only: the thigh and shin touch at the knee, which validate reports as info. */
const drawingIssues = (m: ReturnType<typeof buildLeg>) =>
  m.validate({ drawing: true }).issues.filter((i) => i.code === 'drawing');

describe('spec as the single source', () => {
  it('builds both parts from the spec and the drawing check passes', () => {
    const m = buildLeg();
    expect(m.poisoned).toBeUndefined();
    const s = legSpec(LEG);
    const [thighLow, thighHigh] = span(m, 'thigh');
    const [shinLow, shinHigh] = span(m, 'shin');
    expect(thighLow).toBeCloseTo(s.knee, 6);
    expect(thighHigh).toBeCloseTo(s.hip, 6);
    expect(shinLow).toBeCloseTo(s.ankle, 6);
    expect(shinHigh).toBeCloseTo(s.knee, 6);
    expect(drawingIssues(m)).toEqual([]);
  });

  it('changes both parts and the drawing together from one edited number', () => {
    const before = buildLeg();
    const after = buildLeg({ ...LEG, ratio: 1.618 });
    const knee = (m: ReturnType<typeof buildLeg>) => span(m, 'thigh')[0];
    expect(knee(after)).toBeLessThan(knee(before));
    expect(span(after, 'shin')[1]).toBeCloseTo(knee(after), 6);
    expect(span(after, 'thigh')[1]).toBeCloseTo(LEG.length, 6);
    const dimension = (m: ReturnType<typeof buildLeg>, id: string) =>
      m.diagnostics().drawings[0]?.dimensions.find((d) => d.id === id)?.value;
    expect(dimension(after, 'thigh length')).toBeCloseTo(legSpec({ ...LEG, ratio: 1.618 }).thigh.length, 6);
    expect(drawingIssues(after)).toEqual([]);
  });

  it('flags parts that were not built from the spec the drawing reads', () => {
    const m = model();
    m.drawing(legDrawing(legSpec({ ...LEG, length: 1.2 })));
    thigh(m, legSpec(LEG));
    shin(m, legSpec(LEG));
    const found = drawingIssues(m);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((i) => (i.detail as { check?: string }).check === 'silhouette')).toBe(true);
  });
});
