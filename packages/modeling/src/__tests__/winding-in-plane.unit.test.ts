import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { windingNumber } from '../geom';
import { EditMesh } from '../mesh';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import { rig } from '../rig';
import { sel } from '../selectors';

/** A bar along X, 0.2 x 0.04 x 0.02, with a 0.04 wide notch cut 0.02 up from its underside. */
const NOTCHED_BAR: Point2[] = [
  [0, 0],
  [0.08, 0],
  [0.08, 0.02],
  [0.12, 0.02],
  [0.12, 0],
  [0.2, 0],
  [0.2, 0.04],
  [0, 0.04],
];

function outline(start: number): Point2[] {
  const n = NOTCHED_BAR.length;
  return NOTCHED_BAR.map((_, i) => NOTCHED_BAR[(i + start) % n] as Point2);
}

function notchedBar(m: Model, start: number): void {
  m.extrudePolygon({ points: outline(start), holes: [], depth: 0.02, label: 'a' });
}

/** The same bar as one closed mesh of two concave caps and eight side quads. */
function notchedBarMesh(start: number): EditMesh {
  const points = outline(start);
  const n = points.length;
  const mesh = new EditMesh();
  for (const z of [0, 0.02]) for (const [x, y] of points) mesh.addVertex(x, y, z);
  const ring = points.map((_, i) => i);
  const faces = [
    [...ring].reverse(),
    ring.map((i) => i + n),
    ...ring.map((i) => [i, (i + 1) % n, ((i + 1) % n) + n, i + n]),
  ];
  for (const loop of faces) {
    const added = mesh.addFace(loop);
    if (!added.ok) throw added.error;
  }
  return mesh;
}

function boxMesh(): EditMesh {
  const mesh = new EditMesh();
  for (const z of [-0.05, 0.05])
    for (const [x, y] of [
      [-0.05, -0.05],
      [0.05, -0.05],
      [0.05, 0.05],
      [-0.05, 0.05],
    ] as const)
      mesh.addVertex(x, y, z);
  for (const loop of [
    [3, 2, 1, 0],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ]) {
    const added = mesh.addFace(loop);
    if (!added.ok) throw added.error;
  }
  return mesh;
}

/** A block under the bar, seated on both sides of the notch, with a 0.01 wide tenon rising at `x`. */
function seatWithTenon(x: number, rise: number): Point2[] {
  return [
    [0.06, -0.02],
    [0.14, -0.02],
    [0.14, 0],
    [x + 0.005, 0],
    [x + 0.005, rise],
    [x - 0.005, rise],
    [x - 0.005, 0],
    [0.06, 0],
  ];
}

function interferenceOf(build: (m: Model) => void) {
  const m = model();
  build(m);
  const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
  r.bindRigid(sel.createdBy('a'), 'root', { part: 'a' });
  r.bindRigid(sel.createdBy('b'), 'root', { part: 'b' });
  const t = r.interference({}, { tolerance: 1e-6 });
  if (!t.ok) throw t.error;
  return t.value;
}

describe('winding number of a point in the plane of a face', () => {
  it('reads outside in the notch void, in the plane of the concave side faces', () => {
    for (let start = 0; start < NOTCHED_BAR.length; start++) {
      const mesh = notchedBarMesh(start);
      const faces = mesh.faces();
      expect(windingNumber(mesh, faces, [0.04, 0.02, 0.01])).toBeCloseTo(1, 9);
      for (const z of [0, 0.02]) {
        for (const x of [0.085, 0.1, 0.115]) {
          for (const y of [0, 0.01, 0.019]) {
            const p: Tuple3 = [x, y, z];
            expect(windingNumber(mesh, faces, p), `start ${start} at ${p}`).toBeCloseTo(0, 9);
          }
        }
      }
    }
  });

  it('reads a half on a face, a quarter on an edge and one inside', () => {
    const mesh = boxMesh();
    const faces = mesh.faces();
    expect(windingNumber(mesh, faces, [0.05, 0.01, 0.02])).toBeCloseTo(0.5, 9);
    expect(windingNumber(mesh, faces, [0.05, 0.05, 0.02])).toBeCloseTo(0.25, 9);
    expect(windingNumber(mesh, faces, [0.01, 0.02, 0.03])).toBeCloseTo(1, 9);
    expect(windingNumber(mesh, faces, [0.2, 0.01, 0.02])).toBeCloseTo(0, 9);
    expect(windingNumber(mesh, faces, [0.05, 0.2, 0.02])).toBeCloseTo(0, 9);
  });
});

describe('interference of a member seated across a halving notch', () => {
  it('passes a seat whose tenon rises into the notch void flush with both side planes', () => {
    for (let start = 0; start < NOTCHED_BAR.length; start++) {
      for (const x of [0.09, 0.1, 0.11]) {
        const report = interferenceOf((m) => {
          notchedBar(m, start);
          m.extrudePolygon({ points: seatWithTenon(x, 0.01), holes: [], depth: 0.02, label: 'b' });
        });
        expect(report.pairs.length, `start ${start} x ${x}`).toBe(1);
        expect(report.pass, `start ${start} x ${x}`).toBe(true);
        expect(report.pairs[0]?.depth).toBeLessThan(1e-9);
      }
    }
  });

  it('still flags a seat whose tenon rises past the notch into the bar', () => {
    const report = interferenceOf((m) => {
      notchedBar(m, 0);
      m.extrudePolygon({ points: seatWithTenon(0.1, 0.03), holes: [], depth: 0.02, label: 'b' });
    });
    expect(report.pass).toBe(false);
    expect(report.pairs[0]?.status).toBe('confirmed');
    expect(report.pairs[0]?.depth).toBeGreaterThan(0.004);
  });

  it('still flags a block sunk into the bar beside the notch', () => {
    for (let start = 0; start < NOTCHED_BAR.length; start++) {
      const report = interferenceOf((m) => {
        notchedBar(m, start);
        m.box({ size: [0.01, 0.02, 0.02], center: [0.04, 0.005, 0.01], label: 'b' });
      });
      expect(report.pass, `start ${start}`).toBe(false);
      expect(report.pairs[0]?.status).toBe('confirmed');
      expect(report.pairs[0]?.depth).toBeGreaterThan(0.004);
    }
  });

  it('still flags a block that fills the notch and rises into the bar above it', () => {
    const report = interferenceOf((m) => {
      notchedBar(m, 0);
      m.box({ size: [0.04, 0.03, 0.02], center: [0.1, 0.015, 0.01], label: 'b' });
    });
    expect(report.pass).toBe(false);
    expect(report.pairs[0]?.status).toBe('confirmed');
  });
});
