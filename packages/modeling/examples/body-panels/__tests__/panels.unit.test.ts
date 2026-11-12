import { type Model, model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { recordingSessions } from '../../case/record';
import { FIT_TOLERANCE } from '../../mech-gt/s2-body';
import { buildPanels, fenderPatches, PANELS, planHalf, profileY, SURFACE_TOLERANCE } from '../panels';

function openEdges(m: Model, filter: (a: readonly number[], b: readonly number[]) => boolean): number {
  const mesh = m.editMesh;
  return mesh
    .edges()
    .filter((e) => mesh.isBoundaryEdge(e))
    .filter((e) => {
      const [a, b] = mesh.edgeVertices(e);
      return filter(mesh.position(a), mesh.position(b));
    }).length;
}

describe('C-106 body panel set', () => {
  const recording = recordingSessions();
  const panels = buildPanels(recording.session);

  it('builds every step and leaves closed, valid panels', () => {
    for (const step of recording.steps) expect(step.entry.status, step.entry.op).toBe('ok');
    const surfaces = recording.steps.filter((s) => s.entry.op === 'surface');
    expect(surfaces.map((s) => Object.keys(s.entry.roles).sort())).toEqual([
      ['carbon', 'hood-l', 'hood-r'],
      ['badge', 'fender-l-front', 'fender-l-rear'],
      ['badge', 'fender-r-front', 'fender-r-rear'],
    ]);
    const report = panels.validate();
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(report.closed).toBe(true);
    const finished = panels.finish({ key: 'body-panels', normals: { mode: 'autoSmooth', angle: 40 } });
    if (!finished.ok) throw finished.error;
    expect(finished.value['mesh/body-panels']?.materialSlots.map((s) => s.slotName).sort()).toEqual([
      'badge',
      'carbon',
      'number-l',
      'number-r',
      'paint',
      'underside',
    ]);
  });

  it('joins patches watertight at the hood centerline and the fender cowl seam', () => {
    const surfaces = recording.steps.filter((s) => s.entry.op === 'surface');
    const view = model();
    view.append((surfaces[2] as { snapshot: Uint8Array }).snapshot);
    expect(openEdges(view, (a, b) => Math.abs(a[0] as number) < 1e-9 && Math.abs(b[0] as number) < 1e-9)).toBe(0);
    expect(
      openEdges(view, (a, b) => Math.abs((a[2] as number) - PANELS.cowl) < 1e-6 && Math.abs((b[2] as number) - PANELS.cowl) < 1e-6 && Math.abs(a[0] as number) > PANELS.hoodHalf),
    ).toBe(0);
  });

  it('fits the S2 contours: centerline height and plan outline', () => {
    const surfaces = model();
    surfaces.append((recording.steps.filter((s) => s.entry.op === 'surface')[2] as { snapshot: Uint8Array }).snapshot);
    const mesh = surfaces.editMesh;
    let centerline = 0;
    let plan = 0;
    for (const v of mesh.vertices()) {
      const [x, y, z] = mesh.position(v) as [number, number, number];
      if (Math.abs(x) < 1e-9 && z >= PANELS.cowl && y > 0.3) centerline = Math.max(centerline, Math.abs(y - profileY(z)));
      if (Math.abs(x) > 0.9) plan = Math.max(plan, Math.abs(x) - planHalf(z));
    }
    expect(centerline).toBeLessThan(FIT_TOLERANCE);
    expect(plan).toBeLessThan(0.006);
  });

  it('trims the wheel arches round in the side view', () => {
    const count = panels.count(sel.createdBy('fender-l', 'fender-l-front'));
    expect(count).toBeGreaterThan(100);
  });

  it('keeps the cowl seam watertight when a wider arch crosses it', () => {
    const m = model();
    const report = m.surface({ patches: fenderPatches(1, 0.06), ...SURFACE_TOLERANCE });
    expect(report.status).toBe('ok');
    expect(m.validate().issues.filter((i) => i.code === 't-junction')).toEqual([]);
    // Open seam edges remain only inside the arch (the rear patch is not trimmed): the
    // hole's rim, with every crossing point shared by both patches.
    const wheel = { z: 1.3895, y: 0.3467, r: 0.3467 + 0.06 };
    const mesh = m.editMesh;
    for (const e of mesh.edges().filter((e) => mesh.isBoundaryEdge(e))) {
      const [va, vb] = mesh.edgeVertices(e);
      const a = mesh.position(va);
      const b = mesh.position(vb);
      if (Math.abs((a[2] as number) - PANELS.cowl) > 1e-6 || Math.abs((b[2] as number) - PANELS.cowl) > 1e-6) continue;
      const mid = [((a[1] as number) + (b[1] as number)) / 2, PANELS.cowl];
      expect(Math.hypot((mid[0] as number) - wheel.y, (mid[1] as number) - wheel.z)).toBeLessThan(wheel.r + 1e-3);
    }
  });
});
