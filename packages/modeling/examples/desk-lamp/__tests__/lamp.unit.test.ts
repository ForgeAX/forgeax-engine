import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Model, model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { triangleSet } from '../../../src/__tests__/contract';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildLamp, LAMP_DEFAULTS, type LampParameters } from '../lamp';
import pack from '../lamp.pack';

const SOURCE = fileURLToPath(new URL('../lamp.ts', import.meta.url));
const VARIANTS: readonly LampParameters[] = [
  { height: 0.32, reach: 25, shadeRadius: 0.09 },
  { height: 0.15, reach: 55, shadeRadius: 0.06 },
];

function identity(m: Model) {
  const inspection = m.inspect();
  return {
    labels: inspection.labels,
    tags: Object.fromEntries(inspection.tags.map((t) => [t, m.count(sel.tag(t))])),
    materials: Object.fromEntries(inspection.materials.map((s) => [s, m.count(sel.material(s))])),
  };
}

describe('C-002 desk lamp', () => {
  it('builds without failure and its history maps onto the source line by line', () => {
    const recording = recordingSessions();
    const lamp = buildLamp(LAMP_DEFAULTS, recording.session);
    expect(lamp.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.length).toBeGreaterThanOrEqual(40);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    expect(new Set(steps.map((s) => s.session))).toEqual(
      new Set(['base', 'switch', 'clip', 'bulb', 'shade', 'lamp']),
    );
  });

  it('covers the operators and selectors C-001 did not use', () => {
    const recording = recordingSessions();
    buildLamp(LAMP_DEFAULTS, recording.session);
    const ops = new Set(recording.steps.map((s) => s.entry.op));
    for (const op of ['revolve', 'extrudePolygon', 'cone', 'bisect', 'split', 'triangulate', 'fillHoles', 'duplicate', 'disconnect']) {
      expect(ops).toContain(op);
    }
    const text = readFileSync(SOURCE, 'utf8');
    for (const selector of ['sel.near(', 'sel.thin(', '.loop()', '.ring()']) expect(text).toContain(selector);
  });

  it('validates with no errors and no warnings, also with a 0.5 mm wall check', () => {
    const report = buildLamp().validate({ minThickness: 0.0005 });
    expect(report.pass).toBe(true);
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('keeps every label, role, tag and material region when upstream parameters change', () => {
    const base = buildLamp();
    for (const variant of VARIANTS) expect(identity(buildLamp(variant))).toEqual(identity(base));
    for (const m of [base, ...VARIANTS.map((v) => buildLamp(v))]) {
      expect(m.count(sel.createdBy('vent', 'inner'))).toBe(0);
      expect(m.count(sel.createdBy('vent-depth', 'top'))).toBe(6);
      expect(m.count(sel.createdBy('grip', 'top'))).toBe(12);
      expect(m.count(sel.createdBy('clip-end', 'cap'))).toBe(2);
      expect(m.count(sel.createdBy('socket', 'top').one())).toBe(1);
      expect(m.count(sel.material('reflector'))).toBe(m.count(sel.createdBy('liner', 'top')));
      expect(m.count(sel.thin(0.003).and(sel.createdBy('shade')))).toBe(24);
    }
  });

  it('the whole declared parameter range builds and validates clean', {
    timeout: 60000,
  }, () => {
    const declared = pack.parameters;
    const range = (name: string) => {
      const p = declared.find((d) => d.name === name) as { minimum: number; maximum: number };
      return [p.minimum, p.maximum, (p.minimum + p.maximum) / 2] as const;
    };
    const [h0, h1, hm] = range('height');
    const [r0, r1, rm] = range('reach');
    const [s0, s1, sm] = range('shadeRadius');
    const points: LampParameters[] = [];
    for (const height of [h0, h1]) {
      for (const reach of [r0, r1]) {
        for (const shadeRadius of [s0, s1]) points.push({ height, reach, shadeRadius });
      }
    }
    points.push(
      { height: hm, reach: rm, shadeRadius: sm },
      { height: h0, reach: rm, shadeRadius: s1 },
      { height: h1, reach: r0 + 2.5, shadeRadius: sm },
      { height: hm, reach: r1 - 2.5, shadeRadius: s0 },
      { height: hm, reach: 25, shadeRadius: s1 },
    );
    for (const p of points) {
      const m = buildLamp(p);
      const problems = m.validate({ minThickness: 0.0005 }).issues.filter((i) => i.severity !== 'info');
      expect([p, m.poisoned?.code, problems.map((i) => i.code)]).toEqual([p, undefined, []]);
    }
  });

  it('exports, lifts and re-exports to the same triangles', () => {
    const first = buildLamp().toMesh({ normals: { mode: 'weighted' } });
    if (!first.ok) throw first.error;
    const lifted = model();
    expect(lifted.lift(first.value.mesh).status).toBe('ok');
    const again = lifted.toMesh({ normals: { mode: 'weighted' } });
    if (!again.ok) throw again.error;
    expect(triangleSet(again.value.mesh)).toEqual(triangleSet(first.value.mesh));
  });
});
