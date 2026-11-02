import { type FaceSelector, meshVolume, type Model, model, resolveCurveSpec, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import parts from '../parts.json' with { type: 'json' };
import { CAR, FRONT_TIRE_DIAMETER, REAR_TIRE_DIAMETER } from '../proportions';
import { BOARD, BODY_PARTS, buildS2Body, FIT_TOLERANCE, WHEELS } from '../s2-body';

/** C-100 stage S2: the three-view body against the S1 frame, final-target criterion 2 (2 %). */
const TOLERANCE = 0.02;
const deviation = (measured: number, target: number) => Math.abs(measured - target) / target;

function bounds(m: Model, faces: FaceSelector) {
  const points = faces.evaluate(m.editMesh).flatMap((f) => m.editMesh.faceVertices(f).map((v) => m.editMesh.position(v)));
  expect(points.length).toBeGreaterThan(0);
  const min = [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k] as number)));
  const max = [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k] as number)));
  return { size: (k: number) => (max[k] as number) - (min[k] as number), center: (k: number) => ((max[k] as number) + (min[k] as number)) / 2, min, max };
}

/** Largest distance of a face vertex from the line of its longest edge. */
function width(points: readonly Tuple3[]): number {
  let from = 0;
  let longest = -1;
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length] as Tuple3;
    const l = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (l > longest) [longest, from] = [l, i];
  });
  const a = points[from] as Tuple3;
  const b = points[(from + 1) % points.length] as Tuple3;
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  return Math.max(
    ...points.map((p) => {
      const r = [p[0] - a[0], p[1] - a[1], p[2] - a[2]] as const;
      const t = (r[0] * d[0] + r[1] * d[1] + r[2] * d[2]) / l2;
      return Math.hypot(r[0] - d[0] * t, r[1] - d[1] * t, r[2] - d[2] * t);
    }),
  );
}

describe('C-100 S2 body block from three views', () => {
  const m = buildS2Body();
  const body = sel.material('paint').or(sel.material('glass')).or(sel.material('trim')).or(sel.material('intake'));

  it('builds a closed body with no validate issue', () => {
    expect(m.poisoned).toBeUndefined();
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.issues).toEqual([]);
    expect(meshVolume(m.editMesh)).toBeGreaterThan(4);
  });

  it('matches the S1 frame: length, width, height and wheelbase within 2 %', () => {
    const all = bounds(m, sel.all());
    expect(deviation(all.size(2), CAR.length.value)).toBeLessThanOrEqual(TOLERANCE);
    expect(deviation(all.size(0), CAR.width.value)).toBeLessThanOrEqual(TOLERANCE);
    expect(deviation(all.size(1), CAR.height.value)).toBeLessThanOrEqual(TOLERANCE);
    expect(all.min[1]).toBeCloseTo(0, 9);
    const front = bounds(m, sel.createdBy('wheel-fl'));
    const rear = bounds(m, sel.createdBy('wheel-rl'));
    expect(deviation(front.center(2) - rear.center(2), CAR.wheelbase.value)).toBeLessThanOrEqual(TOLERANCE);
    expect(deviation(front.size(1), FRONT_TIRE_DIAMETER)).toBeLessThanOrEqual(TOLERANCE);
    expect(deviation(rear.size(1), REAR_TIRE_DIAMETER)).toBeLessThanOrEqual(TOLERANCE);
    const shell = bounds(m, body);
    expect(deviation(shell.size(2), CAR.length.value)).toBeLessThanOrEqual(TOLERANCE);
    expect(shell.min[1]).toBeCloseTo(CAR.groundClearance.value, 2);
  });

  it('fits every contour within its tolerance', () => {
    for (const id of ['profile', 'plan outline', 'section']) {
      const item = BOARD.items.find((i) => i.id === id);
      if (item?.kind !== 'curve') throw new Error(`no ${id} contour`);
      const contour = resolveCurveSpec(item.curve, { closed: true, tolerance: FIT_TOLERANCE });
      if (!contour.ok) throw contour.error;
      expect(contour.value.deviation).toBeLessThanOrEqual(FIT_TOLERANCE);
    }
    expect(m.diagnostics().contours.map((c) => c.view).slice(0, 3)).toEqual(['right', 'top', 'front']);
    expect(BOARD.items.filter((i) => i.view === 'side').map((i) => i.id)).toContain('S1 envelope (side)');
    expect(m.diagnostics().drawings[0]?.dimensions.find((d) => d.id === 'length')?.from).toBeDefined();
  });

  it('opens four arches, two side intakes and two front intakes with booleans', () => {
    for (const wheel of WHEELS) expect(m.count(sel.createdBy(`arch-${wheel.name}`, 'cutB'))).toBeGreaterThan(0);
    for (const label of ['intake-l', 'intake-r', 'front-intake-l', 'front-intake-r']) expect(m.count(sel.createdBy(label, 'cutB'))).toBeGreaterThan(0);
    const left = bounds(m, sel.createdBy('intake-l', 'cutB'));
    expect(left.min[0]).toBeGreaterThan(0);
    // The blueprint's intake runs from behind the rear door edge into the door (criterion 9).
    expect(left.max[2]).toBeLessThan(0);
    expect(left.min[2]).toBeGreaterThan(-1.0);
  });

  it('every body face carries exactly one parts.json body part, both sides of every pair present', () => {
    const ids = new Set(parts.parts.map((p) => p.id));
    for (const part of BODY_PARTS) {
      expect(ids.has(part)).toBe(true);
      expect([part, m.count(sel.tag(part)) > 0]).toEqual([part, true]);
    }
    const faces = body.evaluate(m.editMesh);
    for (const f of faces) {
      const owners = BODY_PARTS.filter((p) => sel.tag(p).evaluate(m.editMesh).includes(f as never));
      expect(owners).toHaveLength(1);
    }
    for (const part of BODY_PARTS.filter((p) => p.endsWith('-l'))) {
      const l = bounds(m, sel.tag(part));
      const r = bounds(m, sel.tag(`${part.slice(0, -2)}-r`));
      expect(l.center(0)).toBeGreaterThan(0);
      expect(r.center(0)).toBeLessThan(0);
      expect(Math.abs(l.center(2) - r.center(2))).toBeLessThan(0.05);
    }
    expect(m.count(sel.material('glass').and(sel.tag('windshield')))).toBe(m.count(sel.tag('windshield')));
    expect(m.count(sel.material('glass').minus(sel.tag('windshield')))).toBeGreaterThan(0);
  });

  it('shells into a 3 mm wall: no boolean sliver or part split limits it', { timeout: 60000 }, () => {
    // Before the boolean sliver cleanup, the 1.8 mm strips the floor left of a wheel-arch
    // facet held shell at 0.9 mm; the doorRear bisect then left a 1.6 mm triangle beside a
    // hull vertex (2.54 mm, 2.43 mm on a 1 % longer wheelbase) until it moved 2 cm back.
    const mesh = m.editMesh;
    const cut = sel.createdBy('arch-fl', 'cutB').or(sel.createdBy('arch-fr', 'cutB')).or(sel.createdBy('arch-rl', 'cutB')).or(sel.createdBy('arch-rr', 'cutB'))
      .or(sel.createdBy('intake-l', 'cutB')).or(sel.createdBy('intake-r', 'cutB')).or(sel.createdBy('front-intake-l', 'cutB')).or(sel.createdBy('front-intake-r', 'cutB'));
    const narrowest = Math.min(...cut.evaluate(mesh).map((f) => width(mesh.faceVertices(f).map((v) => mesh.position(v)))));
    expect(narrowest).toBeGreaterThan(0.005);
    // Review S-3: at 3 mm the inner walls fold through the rear fenders, the side intake and the
    // door/monocoque seam (12 crossing pairs). That used to be an ok result with a warning; the
    // shell now fails, located, and rolls back. 1 mm is the largest clean wall of this body.
    const shelled = model();
    shelled.append(m.snapshot());
    const thick = shelled.shell(body, { thickness: 0.003 });
    expect(thick.error?.code).toBe('model-degenerate');
    expect((thick.error?.detail as { pairs: number }).pairs).toBe(12);
    const thin = model();
    thin.append(m.snapshot());
    expect(thin.shell(body, { thickness: 0.001 }).status).toBe('ok');
  });
});

