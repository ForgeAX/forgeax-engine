import { type Drawing, type DrawingItem, drawingCurve3, resolveDrawing } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { alongEdges, measureTurnaroundStructure, type Segment, TURNAROUND_STRUCTURE } from '../drawing/turnaround-structure.ts';
import { buildFaceted } from '../faceting.ts';
import { PLAN_UNITS } from '../plan-units.ts';
import { SHEET_VIEWS } from '../reference.ts';
import { checkTurnaround } from '../turnaround.ts';

/** C-200 turnaround with structure lines and the G6 facet plan per unit, against the G6 model. */
describe('C-200 turnaround structure drawing', () => {
  const resolved = resolveDrawing(TURNAROUND_STRUCTURE);
  const unitLinks = TURNAROUND_STRUCTURE.items.filter((i) => i.link?.startsWith('unit:'));

  it('resolves with the sheet views, the G1 dimensions, plane-change lines and unit lines', () => {
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.views.map((v) => v.id)).toEqual([...SHEET_VIEWS]);
    for (const view of SHEET_VIEWS) {
      const roles = new Set(resolved.value.curves.filter((c) => c.view === view).map((c) => c.role));
      for (const role of ['silhouette', 'guide', 'structure', 'feature', 'construction'] as const) expect(roles.has(role), `${view} ${role}`).toBe(true);
    }
    expect(resolved.value.dimensions.filter((d) => d.id.startsWith('G1 ')).length).toBe(10);
    // 2 zones (torso, skirt) x 6 breaks (front 2, right 2, back 2).
    expect(TURNAROUND_STRUCTURE.items.filter((i) => i.link?.startsWith('plane:')).length).toBe(12);
    expect(unitLinks.every((i) => i.role === 'feature' && i.kind === 'curve')).toBe(true);
    expect(checkTurnaround(TURNAROUND_STRUCTURE).ok).toBe(true);
  });

  it('draws unit lines only for plan units, and one note per plan unit', () => {
    const keys = new Set(PLAN_UNITS.map((u) => `${u.part}/${u.name}`));
    const drawn = new Set(unitLinks.map((i) => (i.link as string).slice(5, (i.link as string).lastIndexOf(':'))));
    for (const k of drawn) expect(keys.has(k), k).toBe(true);
    expect([...drawn].sort()).toEqual(['apron/ruffle', 'back-hair/outer-lobes', 'bangs/clumps', 'skirt/gores', 'skirt/hem', 'trims/collar', 'trims/cuffs', 'trims/socks']);
    const notes = TURNAROUND_STRUCTURE.items.filter((i) => i.kind === 'note' && i.id.startsWith('unit '));
    expect(notes.map((n) => n.id.slice(5)).sort()).toEqual([...keys].sort());
  });

  it('lifts a plane-change line drawn in the front and right views to one 3D curve', () => {
    if (!resolved.ok) throw resolved.error;
    const c = drawingCurve3(resolved.value, 'plane:skirt:front-l', { tolerance: 0.003 });
    if (!c.ok) throw c.error;
    const ys = c.value.points.map((p) => p[1]);
    expect(Math.min(...ys)).toBeLessThan(0.27);
    expect(Math.max(...ys)).toBeGreaterThan(0.41);
  });

  it('counts a facet edge along a line only when it is near and parallel', () => {
    const line: readonly (readonly [number, number])[] = [
      [0, 0],
      [0, 0.1],
    ];
    const along: Segment[] = [
      [
        [0.002, -0.01],
        [0.002, 0.11],
      ],
    ];
    const across: Segment[] = Array.from({ length: 21 }, (_, k): Segment => [
      [-0.02, k * 0.005],
      [0.02, k * 0.005],
    ]);
    expect(alongEdges([line], along).along).toBe(1);
    // Falsifier: crossing edges pass within 0 m of every sample but run across the line.
    expect(alongEdges([line], across).along).toBe(0);
    expect(alongEdges([line], [[[0.01, 0], [0.01, 0.1]]]).along).toBe(0);
  });

  describe('against the G6 remodel', () => {
    const m = buildFaceted();
    const r = measureTurnaroundStructure(m);
    const unit = (name: string, view = 'front') => r.units.find((u) => u.unit === name && u.view === view);

    it('records the silhouette IoU of each view', () => {
      // Below the kernel's 0.93: the model's tail sits on the other side of the drawn one in front
      // and back (the sheet mirrors it, finding R-1); the rest is hair and skirt.
      expect(r.iou.front).toBeGreaterThan(IOU_FLOOR.front);
      expect(r.iou.right).toBeGreaterThan(IOU_FLOOR.right);
      expect(r.iou.back).toBeGreaterThan(IOU_FLOOR.back);
    });

    it('finds facet edges along the unit lines the model builds, at chance where it does not', () => {
      // Measured 2026-10-25 (along / control): bangs 0.969 / 0.396; gores front 0.836 / 0.436,
      // back 0.873 / 0.455, right 0.491 / 0.332; back-hair lobes 0.161 / 0.041; torso plane change
      // front 0.825 / 0.25.
      const built: readonly [string, string, number, number][] = [
        ['bangs/clumps', 'front', 0.9, 0.4],
        ['skirt/gores', 'front', 0.75, 0.3],
        ['skirt/gores', 'back', 0.75, 0.3],
        ['skirt/gores', 'right', 0.4, 0.1],
        ['back-hair/outer-lobes', 'back', 0.12, 0.08],
      ];
      for (const [name, view, along, lead] of built) {
        const u = unit(name, view);
        expect(u?.along, `${name} ${view}`).toBeGreaterThan(along);
        expect((u?.along ?? 0) - (u?.control ?? 1), `${name} ${view}`).toBeGreaterThan(lead);
      }
      const torso = r.planes.find((p) => p.zone === 'torso' && p.view === 'front');
      expect((torso?.along ?? 0) - (torso?.control ?? 1)).toBeGreaterThan(0.4);
      // The collar ring: every sample along an edge (1.0), but the band's dense rows give a high
      // control (0.85), so it discriminates weakly.
      expect(unit('trims/collar')?.along).toBeGreaterThan(0.95);
      // Finding, at chance (along within 0.1 of control): the hem band's block columns are not
      // built (facet-plan skirt), 0.448 against 0.451.
      const hem = unit('skirt/hem');
      expect(Math.abs((hem?.along ?? 0) - (hem?.control ?? 0))).toBeLessThan(0.1);
    });

    const shifted = (prefix: string): Drawing => ({
      ...TURNAROUND_STRUCTURE,
      items: TURNAROUND_STRUCTURE.items.map((i): DrawingItem => {
        if (!i.link?.startsWith(prefix) || i.kind !== 'curve' || !('points' in i.curve)) return i;
        return { ...i, curve: { ...i.curve, points: i.curve.points.map((p) => [p[0] + 0.012, p[1]] as const) } };
      }),
    });

    it('drops the bang partings and the gore borders toward chance when the drawing moves them 12 mm sideways (falsifier)', () => {
      const bangs = measureTurnaroundStructure(m, shifted('unit:bangs/clumps:')).units.find((u) => u.unit === 'bangs/clumps' && u.view === 'front');
      expect(bangs?.along).toBeLessThan(0.6);
      const gores = measureTurnaroundStructure(m, shifted('unit:skirt/gores:')).units.find((u) => u.unit === 'skirt/gores' && u.view === 'front');
      expect(gores?.along).toBeLessThan(0.6);
    });
  });
});

/** Measured 2026-10-25 on the G6 remodel: front 0.818, right 0.829, back 0.757 (kernel floor 0.93); floors 0.02 below. */
const IOU_FLOOR = { front: 0.798, right: 0.809, back: 0.737 };
