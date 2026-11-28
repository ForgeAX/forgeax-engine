import { describe, expect, it } from 'vitest';
import { type Model, model } from '../model';
import { rig } from '../rig';
import { sel } from '../selectors';

/** Two overlapping parts; `open` removes the top face of `a`, so `a` has edges with one face. */
function overlapping(open: boolean) {
  const m: Model = model();
  m.box({ size: [0.1, 0.1, 0.1], center: [0, 0, 0], label: 'a' });
  m.box({ size: [0.05, 0.05, 0.05], center: [0.04, 0, 0], label: 'b' });
  if (open) m.delete(sel.createdBy('a').and(sel.facing('+y', 10)));
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      { name: 'j', parent: 'root', position: [0, 0, 0], kind: 'prismatic', axis: 'x' },
    ],
  });
  r.bindRigid(sel.createdBy('a'), 'root', { part: 'a' });
  r.bindRigid(sel.createdBy('b'), 'j', { part: 'b' });
  return r;
}

describe('interference basis', () => {
  it('names the criterion that decided each pair: depth for closed parts, reach when one is open', () => {
    for (const [open, basis] of [
      [false, 'depth'],
      [true, 'reach'],
    ] as const) {
      const report = overlapping(open).interference({}, { tolerance: 0.001 });
      if (!report.ok) throw report.error;
      expect(report.value.pairs.length).toBeGreaterThan(0);
      expect(report.value.pairs.every((p) => p.basis === basis)).toBe(true);
    }
  });

  it('carries the basis into the scan pair', () => {
    for (const [open, basis] of [
      [false, 'depth'],
      [true, 'reach'],
    ] as const) {
      const scan = overlapping(open).scan({
        keys: [
          { u: 0, pose: { j: 0 } },
          { u: 1, pose: { j: 0.005 } },
        ],
      });
      if (!scan.ok) throw scan.error;
      expect(scan.value.pairs.length).toBeGreaterThan(0);
      expect(scan.value.pairs.every((p) => p.basis === basis)).toBe(true);
    }
  });
});
