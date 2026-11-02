import { describe, expect, it } from 'vitest';
import { add, cross, dot, length, newell, scale, sub, type Tuple3, triangulateLoop } from '../geom';
import type { EditMesh } from '../mesh';
import { type Model, model } from '../model';
import type { NurbsSurface } from '../nurbs';
import { sel } from '../selectors';
import { unitOffsets } from '../shell';

const T = 0.003;
const RUN_OUT = [
  [0, 0.012],
  [0.55, 0.012],
  [1, 0],
] as const;

/** A bilinear patch through four corners: [u0v0, u0v1], [u1v0, u1v1]. */
function quad(a: Tuple3, b: Tuple3, c: Tuple3, d: Tuple3): NurbsSurface {
  return {
    degreeU: 1,
    degreeV: 1,
    points: [
      [a, b],
      [c, d],
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

/** Two planar panels meeting at a 90 degree crease, rolled by a G2 blend. */
function roll(radius: number | readonly (readonly [number, number])[]): Model {
  const m = model();
  const done = m.surface({
    patches: [
      { name: 'a', surface: quad([0, 0, 0], [0, -0.2, 0], [1, 0, 0], [1, -0.2, 0]) },
      { name: 'b', surface: quad([0, 0, 0.2], [0, 0, 0], [1, 0, 0.2], [1, 0, 0]) },
    ],
    blends: [{ between: ['a', 'b'], radius, continuity: 'G2', name: 'roll' }],
    chord: 0.0005,
  });
  expect(done.status).toBe('ok');
  return m;
}

/**
 * Two planar panels meeting at a 17 degree crease, rolled 12 mm out to nothing over a short run:
 * the 6 degree mesh angle cuts the run-out into long faces a fraction of a millimetre wide.
 */
function shallowRoll(): Model {
  const L = 0.15;
  const turn = (17 * Math.PI) / 180;
  const far: Tuple3 = [0, 0.2 * Math.cos(turn), 0.2 * Math.sin(turn)];
  const m = model();
  const done = m.surface({
    patches: [
      { name: 'a', surface: quad([0, 0, 0], [0, -0.2, 0], [L, 0, 0], [L, -0.2, 0]) },
      { name: 'b', surface: quad(far, [0, 0, 0], add(far, [L, 0, 0]), [L, 0, 0]) },
    ],
    blends: [{ between: ['a', 'b'], radius: RUN_OUT, continuity: 'G2', name: 'roll' }],
    chord: 0.0007,
    angle: 6,
  });
  expect(done.status).toBe('ok');
  return m;
}

function triangles(mesh: EditMesh, faces: readonly number[]): [Tuple3, Tuple3, Tuple3][] {
  return faces.flatMap((f) => {
    const points = mesh.faceVertices(f).map((v) => mesh.position(v));
    const indices = triangulateLoop(points) ?? [];
    return Array.from(
      { length: indices.length / 3 },
      (_, t) =>
        [0, 1, 2].map((k) => points[indices[t * 3 + k] as number] as Tuple3) as [
          Tuple3,
          Tuple3,
          Tuple3,
        ],
    );
  });
}

/** Distance from q to triangle abc (closest point by region, Ericson 5.1.5). */
function triangleDistance(q: Tuple3, a: Tuple3, b: Tuple3, c: Tuple3): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(q, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return length(ap);
  const bp = sub(q, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return length(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return length(sub(q, add(a, scale(ab, d1 / (d1 - d3)))));
  const cp = sub(q, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return length(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return length(sub(q, add(a, scale(ac, d2 / (d2 - d6)))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return length(sub(q, add(b, scale(sub(c, b), w))));
  }
  const n = cross(ab, ac);
  return Math.abs(dot(ap, n)) / length(n);
}

/**
 * Shell the rolled panels by T and return the smallest distance from an inner vertex to the
 * outer surface (the panels' faces before the shell, which an inward shell keeps in place).
 */
function shellAndMeasure(m: Model, miter = true): number {
  const outer = triangles(m.editMesh, m.editMesh.faces());
  const op = m.shell(sel.all(), { thickness: T, label: 'wall' });
  expect(op.status).toBe('ok');
  expect(
    op.diagnostics?.some((d) => d.message.includes('miter of their bounding planes')) ?? false,
  ).toBe(miter);
  const mesh = m.editMesh;
  const inner = new Set(
    sel
      .createdBy('wall', 'inner')
      .evaluate(mesh)
      .flatMap((f) => mesh.faceVertices(f)),
  );
  expect(inner.size).toBeGreaterThan(0);
  let min = Infinity;
  for (const v of inner) {
    const q = mesh.position(v);
    for (const [a, b, c] of outer) min = Math.min(min, triangleDistance(q, a, b, c));
  }
  const issues = m.validate().issues.map((i) => i.code);
  expect(issues).not.toContain('self-intersection');
  expect(issues).not.toContain('face-flipped');
  // Rims get no corner values: project both channels before export.
  m.uv.project({ mode: 'box', scale: 1 });
  m.uv.project({ mode: 'box', scale: 1, channel: 'uv1' });
  const finished = m.finish({ key: 'rolled-shell' });
  if (!finished.ok) throw finished.error;
  return min;
}

/** Faces whose inward offset by `t` along the shell's own vertex offsets inverts. */
function ownCollapse(m: Model, t: number): number {
  const mesh = m.editMesh;
  const faces = mesh.faces();
  const offsets = unitOffsets(mesh, faces);
  if (!offsets.ok) throw offsets.error;
  return faces.filter((f) => {
    const loop = mesh.faceVertices(f);
    const normal = newell(loop.map((v) => mesh.position(v)));
    const moved = loop.map((v) =>
      sub(mesh.position(v), scale(offsets.value.unit.get(v) as Tuple3, t)),
    );
    return dot(newell(moved), normal) <= 0;
  }).length;
}

describe('shell miters a collapsing band', () => {
  it('shells a constant 2 mm roll by 3 mm with the wall at least the thickness', () => {
    const min = shellAndMeasure(roll(0.002));
    expect(min).toBeGreaterThanOrEqual(0.98 * T);
  });

  it('shells a 12 mm roll running out to a crease by 3 mm', () => {
    const min = shellAndMeasure(roll(RUN_OUT));
    expect(min).toBeGreaterThanOrEqual(0.98 * T);
  });

  it('shells a 17 degree crease whose run-out roll meshes into long slivers by 3 mm', () => {
    // Before the pure-miter fallback this input failed: model-precondition, limitedBy
    // 'collapse', maxThickness 0.0019738: the band radius, measured to the bounding faces'
    // vertices along the long faces, kept the slivers' own (inverting) offsets. Since the
    // blend trims its faces the run-out no longer inverts, so no miter is needed; with
    // its tip's seam split between both faces it failed on clearance (1e-7).
    const min = shellAndMeasure(shallowRoll(), false);
    expect(min).toBeGreaterThanOrEqual(0.98 * T);
  });

  it('falsifier: the 2 mm roll inverts under its own vertex offsets', () => {
    // Before the miter (2072b52) this input failed: model-precondition, limitedBy 'collapse',
    // maxThickness 0.0013089692936609936.
    expect(ownCollapse(roll(0.002), T)).toBeGreaterThan(0);
    expect(ownCollapse(roll(0.002), 0.0012)).toBe(0);
    expect(ownCollapse(roll(0.012), T)).toBe(0);
  });

  it("direction 'both' miters only the collapsing side", () => {
    // Before: the outer wall of a 2 mm roll shelled 6 mm 'both' took the miter too and sat up
    // to 4.23 mm from the design surface (the sharp corner of the bounding planes).
    for (const radius of [0.002, 0.004]) {
      const m = roll(radius);
      const design = triangles(m.editMesh, m.editMesh.faces());
      const op = m.shell(sel.all(), { thickness: 2 * T, direction: 'both', label: 'wall' });
      expect(op.status).toBe('ok');
      const mesh = m.editMesh;
      const wall = new Set([
        ...sel.createdBy('wall', 'inner').evaluate(mesh),
        ...sel.createdBy('wall', 'rim').evaluate(mesh),
      ]);
      const outer = new Set(
        mesh
          .faces()
          .filter((f) => !wall.has(f))
          .flatMap((f) => mesh.faceVertices(f)),
      );
      let [min, max] = [Infinity, 0];
      for (const v of outer) {
        let d = Infinity;
        for (const [a, b, c] of design)
          d = Math.min(d, triangleDistance(mesh.position(v), a, b, c));
        [min, max] = [Math.min(min, d), Math.max(max, d)];
      }
      expect(min).toBeGreaterThan(0.999 * T);
      expect(max).toBeLessThan(1.01 * T);
      const issues = m.validate().issues.map((i) => i.code);
      expect(issues).not.toContain('self-intersection');
      expect(issues).not.toContain('face-flipped');
    }
  });

  it('keeps genuinely thin bodies failing: the miter stays local', () => {
    const slab = model();
    slab.box({ size: [0.2, 0.2, 0.002] });
    const sliver = slab.shell(sel.all(), { thickness: T });
    expect(sliver.error?.code).toBe('model-precondition');
    expect(['collapse', 'clearance']).toContain(sliver.error?.detail?.limitedBy);
    const walls = model();
    walls.box({ size: [0.2, 0.005, 0.2] });
    const close = walls.shell(sel.all(), { thickness: T });
    expect(close.error?.code).toBe('model-precondition');
    expect(['collapse', 'clearance']).toContain(close.error?.detail?.limitedBy);
    const both = roll(0.002);
    both.box({ size: [0.2, 0.2, 0.002], center: [0.5, 0.5, 0.5] });
    const mixed = both.shell(sel.all(), { thickness: T });
    expect(mixed.error?.code).toBe('model-precondition');
    expect(['collapse', 'clearance']).toContain(mixed.error?.detail?.limitedBy);
    expect((mixed.error?.detail?.point as Tuple3)[2]).toBeCloseTo(0.5, 2);
  });
});
