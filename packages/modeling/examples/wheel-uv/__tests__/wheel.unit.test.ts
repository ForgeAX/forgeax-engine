import { fileURLToPath } from 'node:url';
import { measureUv, type OpReport, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildWheel, WHEEL_DEFAULTS, type WheelParameters } from '../wheel';
import pack from '../wheel.pack';

const SOURCE = fileURLToPath(new URL('../wheel.ts', import.meta.url));

type Metrics = Record<string, number>;
const metrics = (entry: OpReport) =>
  (entry.diagnostics?.find((d) => d.severity === 'info')?.detail as { metrics: Metrics }).metrics;

describe('C-013 UV unwrap of a tire and hub cap', () => {
  it('records every step on its source line; the unwrap and pack jobs report on the TS baseline', { timeout: 120000 }, () => {
    const recording = recordingSessions();
    const wheel = buildWheel(WHEEL_DEFAULTS, recording.session);
    expect(wheel.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.length).toBeGreaterThanOrEqual(20);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    const uv = steps.filter((s) => s.entry.op === 'uv.unwrap' || s.entry.op === 'uv.pack');
    expect(uv.map((s) => `${s.session}.${s.entry.op}`)).toEqual([
      'tire.uv.unwrap',
      'tire.uv.unwrap',
      'tire.uv.pack',
      'cap.uv.unwrap',
      'cap.uv.unwrap',
      'cap.uv.pack',
      'wheel.uv.pack',
    ]);
    for (const step of uv) {
      const info = step.entry.diagnostics?.find((d) => d.severity === 'info');
      expect(info?.detail).toMatchObject({ backend: 'ts', quality: 'baseline' });
    }
    const [first, second] = uv.map((s) => s.entry);
    // With only the radial and sidewall seams the pocketed, grooved tread strip cannot develop: the metrics and a warning say so.
    expect(metrics(first as OpReport).areaDistortion).toBeGreaterThan(4);
    expect(metrics(first as OpReport).stretchLinf).toBeGreaterThan(2);
    expect((first as OpReport).diagnostics?.some((d) => d.severity === 'warn' && /heavily distorted/.test(d.message))).toBe(true);
    const tire = metrics(second as OpReport);
    // Two radial cuts halve every ring. Sharp seams: 2 sidewalls (with the bead heel),
    // 2 shoulders, the bead seat, 3 ribs and 2 x 3 groove pieces, plus 128 x (4 walls + floor).
    expect(tire.islands).toBe(2 * (2 + 2 + 1 + 3 + 6) + 128 * 5);
    expect(tire.stretchL2).toBeLessThan(1.001);
    expect(tire.stretchLinf).toBeLessThan(1.05);
    expect(tire.areaDistortion).toBeLessThan(1.05);
    expect(tire.texelDensityDispersion).toBeLessThan(0.01);
    expect(tire.flipped).toBe(0);
    expect((second as OpReport).diagnostics?.filter((d) => d.severity === 'warn')).toEqual([]);
    const cap = metrics(uv[3]?.entry as OpReport);
    expect(cap.stretchLinf).toBeLessThan(1.05);
    expect(metrics(uv[4]?.entry as OpReport).stretchL2).toBeLessThan(1.001);
  });

  it('ends with one non-overlapping atlas in [0, 1] and complete uv0', { timeout: 120000 }, () => {
    const wheel = buildWheel();
    const report = wheel.validate({ uniqueUv: true });
    expect(report.issues.filter((i) => i.code.startsWith('uv-'))).toEqual([]);
    const measured = measureUv(wheel.editMesh);
    if (!measured.ok) throw measured.error;
    expect(measured.value.islands.length).toBe(668 + 251);
    expect(measured.value.flipped).toBe(0);
    expect(measured.value.stretchL2).toBeLessThan(1.001);
    expect(measured.value.texelDensityDispersion).toBeLessThan(0.01);
    const mesh = wheel.editMesh;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const [u, v] = mesh.corner('uv0', h) as Float32Array;
        expect((u as number) >= 0 && (u as number) <= 1 && (v as number) >= 0 && (v as number) <= 1).toBe(true);
      }
    }
    expect(wheel.count(sel.tag('tire'))).toBe(2304);
    expect(wheel.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } }).ok).toBe(true);
  });

  it('builds across the declared parameter range with the same island structure', { timeout: 120000 }, () => {
    for (const p of pack.parameters as readonly { name: keyof WheelParameters; minimum: number; maximum: number }[]) {
      for (const value of [p.minimum, p.maximum]) {
        const variant = buildWheel({ ...WHEEL_DEFAULTS, [p.name]: value });
        expect([p.name, value, variant.poisoned?.code]).toEqual([p.name, value, undefined]);
        const issues = variant.validate({ uniqueUv: true }).issues.map((i) => i.code);
        expect(issues).not.toContain('uv-overlap');
      }
    }
  });
});
