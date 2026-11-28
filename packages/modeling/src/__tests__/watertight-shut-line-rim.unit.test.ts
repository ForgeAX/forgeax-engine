import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { sel } from '../selectors';
import type { DtsRow } from '../shut-lines';

/** Panel A with a 4 cm hole; panel B 5 mm above it, bent about x = 0 by `bend` degrees when given. */
function bent(
  bend: number,
  table: DtsRow[],
  extra?: (m: ReturnType<typeof model>) => void,
  radius?: number,
) {
  const m = model();
  m.plane({
    width: 0.1,
    height: 0.1,
    widthSegments: 10,
    heightSegments: 10,
    center: [0, 0, 0],
    tag: 'part:a',
  });
  m.tag(sel.tag('part:a'), 'skin:a');
  m.plane({
    width: 0.1,
    height: 0.1,
    widthSegments: 10,
    heightSegments: 10,
    center: [0, 0, 0.005],
    tag: 'part:b',
  });
  m.tag(sel.tag('part:b'), 'skin:b');
  const tan = Math.tan((bend * Math.PI) / 180);
  for (const v of m.editMesh.vertices()) {
    const p = m.editMesh.position(v);
    if (p[2] > 0.001 && p[0] > 0.0001) m.editMesh.setPosition(v, p[0], p[1], p[2] + p[0] * tan);
  }
  const hole = sel
    .inBox([-0.019, -0.019, -0.001], [0.019, 0.019, 0.001], { by: 'centroid' })
    .and(sel.tag('skin:a'));
  expect(m.delete(hole).status).toBe('ok');
  extra?.(m);
  return m.validate({ watertight: { table, ...(radius === undefined ? {} : { radius }) } });
}
const holeKinds = (v: ReturnType<typeof bent>, tag = 'part:a') =>
  (v.watertight?.chains ?? [])
    .filter(
      (c) =>
        c.part === tag &&
        Math.max(...c.bounds[1].map((x, i) => x - (c.bounds[0][i] as number))) < 0.05,
    )
    .map((c) => c.designed ?? 'undesigned');

/**
 * Panel A (skin:a) has a real 4 cm hole in its middle. Panel B (skin:b) lies 5 mm above it, so B's
 * interior edges are within the 12 mm shut-line reach of the hole rim while B's own free edges
 * are 3 cm away. The DTS row pairs A with B.
 */
function panels(withRow: boolean) {
  const m = model();
  m.plane({
    width: 0.1,
    height: 0.1,
    widthSegments: 10,
    heightSegments: 10,
    center: [0, 0, 0],
    tag: 'part:a',
  });
  m.tag(sel.tag('part:a'), 'skin:a');
  m.plane({
    width: 0.1,
    height: 0.1,
    widthSegments: 10,
    heightSegments: 10,
    center: [0, 0, 0.005],
    tag: 'part:b',
  });
  m.tag(sel.tag('part:b'), 'skin:b');
  const hole = sel
    .inBox([-0.019, -0.019, -0.001], [0.019, 0.019, 0.001], { by: 'centroid' })
    .and(sel.tag('skin:a'));
  expect(m.delete(hole).status).toBe('ok');
  const table: DtsRow[] = withRow ? [{ id: 'D01', parts: ['skin:a', 'skin:b'] }] : [];
  return m.validate({ watertight: { table } });
}

describe('C-3 shut-line proximity uses the partner panel rim, not its interior edges', () => {
  it('a hole in panel A is not excused by interior edges of partner panel B', () => {
    const bare = panels(false);
    const rowed = panels(true);
    const holeChains = (v: ReturnType<typeof panels>) =>
      (v.watertight?.chains ?? [])
        .filter((c) => c.length < 0.2 && c.length > 0.1)
        .map((c) => `${c.kind}:${c.designed ?? 'undesigned'}:${c.length.toFixed(3)}`);
    expect(holeChains(rowed)).toEqual(holeChains(bare));
  });

  it('a fold of the partner panel stays a rim, a shallow bend does not (RIM_FLAT)', () => {
    const row: DtsRow[] = [{ id: 'D01', parts: ['skin:a', 'skin:b'] }];
    const folded = holeKinds(bent(45, row));
    expect(folded).toContain('shut-line');
    const shallow = holeKinds(bent(10, row));
    expect(shallow).toEqual(['undesigned']);
  });

  it('a shut-line row and a clearance row on one partner keep their own edge sets', () => {
    const addC = (m: ReturnType<typeof model>) => {
      m.plane({
        width: 0.1,
        height: 0.1,
        widthSegments: 10,
        heightSegments: 10,
        center: [0, 0, -0.005],
        tag: 'part:c',
      });
      m.tag(sel.tag('part:c'), 'skin:c');
      m.delete(
        sel
          .inBox([-0.019, -0.019, -0.006], [0.019, 0.019, -0.004], { by: 'centroid' })
          .and(sel.tag('skin:c')),
      );
    };
    const rows = (first: 'shut' | 'clear'): DtsRow[] => {
      const shut: DtsRow = { id: 'D01', parts: ['skin:a', 'skin:b'] };
      const clear: DtsRow = { id: 'D02', parts: ['skin:c', 'skin:b'], clearance: { min: 0.001 } };
      return first === 'shut' ? [shut, clear] : [clear, shut];
    };
    for (const first of ['shut', 'clear'] as const) {
      const v = bent(0, rows(first), addC, 0.012);
      expect(
        holeKinds(v, 'part:a').every((k) => k === 'undesigned'),
        first,
      ).toBe(true);
      expect(holeKinds(v, 'part:c').length, first).toBeGreaterThan(0);
      expect(
        holeKinds(v, 'part:c').every((k) => k === 'clearance'),
        first,
      ).toBe(true);
    }
  });
});
