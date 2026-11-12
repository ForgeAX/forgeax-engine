import { meshVolume, resolveCurveSpec, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { CAR } from '../../mech-gt/proportions.ts';
import { BOARD, buildBody, FIT_TOLERANCE, WHEELS } from '../body.ts';

/** C-105: the three-view blockout keeps the public dimensions within the fit tolerance. */
describe('C-105 body blockout from three views', () => {
  const m = buildBody();

  it('builds a closed, valid body with four wheels', () => {
    expect(m.poisoned).toBeUndefined();
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.issues).toEqual([]);
    expect(meshVolume(m.editMesh)).toBeGreaterThan(4);
    for (const wheel of WHEELS) {
      expect(m.count(sel.createdBy(`wheel-${wheel.name}`))).toBeGreaterThan(0);
      expect(m.count(sel.createdBy(`arch-${wheel.name}`, 'cutB'))).toBeGreaterThan(0);
    }
    expect(m.count(sel.material('glass'))).toBeGreaterThan(0);
  });

  it('fits every contour to its trace and keeps the public envelope', () => {
    for (const item of BOARD.items) {
      if (item.kind !== 'curve' || item.role !== 'silhouette' || item.curve.kind !== 'fit') continue;
      const contour = resolveCurveSpec(item.curve, { closed: true, tolerance: FIT_TOLERANCE });
      if (!contour.ok) throw contour.error;
      expect(contour.value.deviation).toBeLessThanOrEqual(FIT_TOLERANCE);
      expect(contour.value.points.length).toBeLessThan(item.curve.points.length / 2);
    }
    const body = sel.material('paint').or(sel.material('glass')).or(sel.material('trim'));
    const points = body
      .evaluate(m.editMesh)
      .flatMap((f) => m.editMesh.faceVertices(f).map((v) => m.editMesh.position(v)));
    const extent = (k: number) =>
      Math.max(...points.map((p) => p[k] as number)) - Math.min(...points.map((p) => p[k] as number));
    const slack = FIT_TOLERANCE + 2 * 0.0005;
    expect(Math.abs(extent(2) - CAR.length.value)).toBeLessThanOrEqual(slack);
    expect(Math.abs(extent(0) - CAR.width.value)).toBeLessThanOrEqual(slack);
    expect(Math.abs(extent(1) + CAR.groundClearance.value - CAR.height.value)).toBeLessThanOrEqual(
      slack,
    );
  });

  it('records the board and the three contours for the drawings', () => {
    const d = m.diagnostics();
    expect(d.drawings[0]?.name).toBe(BOARD.name);
    expect(d.drawings[0]?.curves.map((c) => c.view)).toEqual(['side', 'plan', 'front']);
    expect(d.contours.map((c) => c.view)).toEqual(['right', 'top', 'front']);
    expect(m.inspect().tags).toEqual(
      expect.arrayContaining(['view-right', 'view-top', 'view-front']),
    );
  });
});
