import { describe, expect, it } from 'vitest';
import { type Model, model, type OpReport } from '../model';
import { circle } from '../recipes/common';
import { gearOutline } from '../recipes/gear';
import { type EdgeSelector, sel } from '../selectors';
import { expectContract } from './contract';

/** Gear-like extrusion with a central bore: caps are convex partitions through the hole. */
function gearBlank(): Model {
  const outline = gearOutline(0.004, 18, 20, 4);
  if (!outline.ok) throw outline.error;
  const m = model();
  m.extrudePolygon({
    points: outline.value.points,
    holes: [circle(0.012, 32)],
    depth: 0.012,
    label: 'g',
  });
  return m;
}

/** Plate drilled by `difference`: caps are cut into strips through the holes. */
function drilledPlate(): Model {
  const m = model();
  m.box({ size: [0.4, 0.02, 0.25], label: 'plate' });
  const drills = model();
  for (let i = 0; i < 3; i++) {
    drills.cylinder({
      radiusTop: 0.01,
      radiusBottom: 0.01,
      height: 0.05,
      radialSegments: 16,
      center: [-0.15 + i * 0.1, 0, 0.06],
    });
  }
  m.difference(drills, { label: 'drill' });
  return m;
}

const gearBore = sel
  .createdBy('g', 'hole')
  .toEdges('touching')
  .and(sel.createdBy('g', 'top').toEdges('touching'));
const gearTips = sel
  .createdBy('g', 'side')
  .toEdges('touching')
  .and(sel.createdBy('g', 'top').toEdges('touching'));
const drillRims = sel
  .createdBy('drill', 'cutB')
  .toEdges('touching')
  .and(sel.facing('+y').toEdges('touching'));

function expectFullBevel(m: Model, edges: EdgeSelector, width: number, segments: number): void {
  const selected = m.count(edges);
  expect(selected).toBeGreaterThan(0);
  const op: OpReport = m.bevel(edges, { width, segments, label: 'b' });
  expect(op.status, op.error?.message).toBe('ok');
  expect(op.diagnostics?.filter((d) => d.severity === 'warn') ?? []).toEqual([]);
  expect(m.count(sel.createdBy('b', 'bevel'))).toBeGreaterThanOrEqual(selected * segments);
  expect(m.validate().closed).toBe(true);
  expectContract(m);
}

describe('bevel: rims of holed caps', () => {
  for (const segments of [1, 3]) {
    it(`bevels the bore rim of a partitioned extrusion cap without clamping (segments ${segments})`, () => {
      expectFullBevel(gearBlank(), gearBore, 0.001, segments);
    });

    it(`bevels the tooth rims of a partitioned extrusion cap without clamping (segments ${segments})`, () => {
      expectFullBevel(gearBlank(), gearTips, 0.0002, segments);
    });

    it(`bevels the rims of holes drilled by difference without clamping (segments ${segments})`, () => {
      expectFullBevel(drilledPlate(), drillRims, 0.002, segments);
    });
  }

  it('keeps the bore chamfer at the requested width in the cap plane', () => {
    const m = gearBlank();
    m.bevel(gearBore, { width: 0.001, segments: 1, label: 'b' });
    const mesh = m.editMesh;
    let widest = 0;
    for (const v of mesh.vertices()) {
      const [x, y, z] = mesh.position(v);
      if (Math.abs(z - 0.012) > 1e-9) continue;
      const r = Math.hypot(x, y);
      if (r < 0.02) widest = Math.max(widest, r);
    }
    // Rim corners sit on the 0.012 circle; the chamfer moves them out by width / cos(pi / 32).
    expect(widest).toBeCloseTo(0.012 + 0.001 / Math.cos(Math.PI / 32), 9);
  });
});
