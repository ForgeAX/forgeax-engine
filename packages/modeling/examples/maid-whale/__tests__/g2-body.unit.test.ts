import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildBody } from '../body.ts';
import { bodyMetrics } from '../body-metrics.ts';
import { LANDMARK } from '../reference.ts';

/** C-200 G2 (structure-first): one connected body cage at the dimension targets. */
describe('C-200 G2 base body', () => {
  const m = buildBody();
  const v = m.validate();

  it('is one closed shell with no self-intersection', () => {
    expect(m.poisoned).toBeUndefined();
    expect(v.closed).toBe(true);
    expect(v.issues.filter((i) => i.code === 'self-intersection')).toEqual([]);
    for (const tag of ['torso', 'arm-l', 'arm-r', 'hand-l', 'hand-r', 'leg-l', 'leg-r', 'head']) expect(m.count(sel.tag(tag)), tag).toBeGreaterThan(0);
    // Connected: every region grows from the trunk, so the arms share vertices with it.
    const trunk = new Set(sel.tag('torso').minus(sel.tag('arm-l')).evaluate(m.editMesh).flatMap((f) => m.editMesh.faceVertices(f)));
    expect(sel.tag('arm-l').evaluate(m.editMesh).some((f) => m.editMesh.faceVertices(f).some((x) => trunk.has(x)))).toBe(true);
  });

  it('splits the fist underside into thumb tip, notch and finger roll', () => {
    for (const side of ['l', 'r'] as const) {
      const b = (label: string, role?: 'top') => {
        const r = m.bounds(sel.createdBy(label, role));
        if (!r.ok) throw r.error;
        return r.value;
      };
      const [fingers, thumb, notch] = [b(`hand-${side}-fingers`), b(`hand-${side}-thumb-tip`), b(`hand-${side}-fist`, 'top')];
      // Across the fist (body side first): thumb tip, notch, finger roll; the notch at least 1 cm above both bottoms.
      const x = (q: { min: readonly number[]; max: readonly number[] }) => ((side === 'l' ? 1 : -1) * ((q.min[0] as number) + (q.max[0] as number))) / 2;
      expect(x(thumb), side).toBeLessThan(x(notch));
      expect(x(notch), side).toBeLessThan(x(fingers));
      expect(notch.min[1] - Math.max(fingers.min[1], thumb.min[1]), side).toBeGreaterThan(0.01);
    }
  });

  it('meets the dimension targets', () => {
    const r = bodyMetrics(m);
    const H = 1;
    expect(Math.abs(r.legWidth - 0.089) / 0.089).toBeLessThan(0.02);
    expect(Math.abs(r.legSpacing - 0.154) / 0.154).toBeLessThan(0.02);
    expect(r.handWidth).toBeGreaterThanOrEqual(0.06);
    expect(r.handWidth).toBeLessThanOrEqual(0.07);
    expect(Math.abs(r.handDepth - 0.066) / 0.066).toBeLessThan(0.03);
    expect(Math.abs(r.faceFront - 0.125) / H).toBeLessThan(0.01);
    expect(Math.abs(r.chinZ - 0.09) / H).toBeLessThan(0.01);
    expect(r.toeZ).toBeLessThanOrEqual(0.1);
    // jaw front widths at y 0.63 / 0.64 / 0.65 (sheet 0.10 / 0.14 / 0.17, +-10 %).
    for (const [w, t] of [[r.jaw063, 0.1], [r.jaw064, 0.14], [r.jaw065, 0.17]] as const) expect(Math.abs(w - t) / t).toBeLessThan(0.1);
    // fist bottoms at the sheet's hands (0.304 l / 0.314 r, +-5 mm), x on the hands.
    expect(Math.abs(r.handBottomL - 0.304)).toBeLessThan(0.005);
    expect(Math.abs(r.handBottomR - 0.314)).toBeLessThan(0.005);
    expect(Math.abs(r.handXL - 0.191)).toBeLessThan(0.01);
    expect(Math.abs(r.handXR + 0.2)).toBeLessThan(0.01);
    expect(Math.min(...sel.tag('head').minus(sel.createdBy('neck')).evaluate(m.editMesh).flatMap((f) => m.editMesh.faceVertices(f).map((x) => m.editMesh.position(x)[1] as number)))).toBeGreaterThan((LANDMARK.chin as number) - 0.02);
  });
});
