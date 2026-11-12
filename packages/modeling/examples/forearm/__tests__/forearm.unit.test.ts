import { fileURLToPath } from 'node:url';
import { type Model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import { buildForearm, compareFits, FOREARM_DEFAULTS, type ForearmParameters } from '../forearm';
import pack from '../forearm.pack';

const SOURCE = fileURLToPath(new URL('../forearm.ts', import.meta.url));

function info(step: RecordedStep | undefined): Record<string, unknown> {
  return step?.entry.diagnostics?.find((d) => d.severity === 'info')?.detail ?? {};
}

function identity(m: Model) {
  return {
    faces: m.editMesh.faceCount,
    labels: m.inspect().labels.map((l) => l.label),
    plate: m.count(sel.createdBy('plate')),
    trim: m.count(sel.material('trim')),
  };
}

function recorded(p: ForearmParameters = FOREARM_DEFAULTS) {
  const recording = recordingSessions();
  const m = buildForearm(p, recording.session);
  return { m, recording, steps: attachSourceLines(recording.steps, SOURCE) };
}

describe('C-016 ARAP forearm guard fitted to a posed arm', () => {
  it('builds every step ok and without warnings, mapped to its source line', () => {
    const { m, steps } = recorded();
    expect(m.poisoned).toBeUndefined();
    expect(steps.length).toBeGreaterThanOrEqual(6);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    expect(steps.flatMap((s) => s.entry.diagnostics ?? []).filter((d) => d.severity === 'warn')).toEqual([]);
    const ops = steps.map((s) => `${s.session}.${s.entry.op}`);
    for (const op of ['forearm.arap', 'forearm.smooth.implicit', 'bent.bend']) expect(ops).toContain(op);
    const fit = info(steps.find((s) => s.entry.op === 'arap'));
    const energies = fit.energies as number[];
    expect(energies).toHaveLength(31);
    for (let i = 1; i < energies.length; i++) {
      expect(energies[i] as number).toBeLessThanOrEqual((energies[i - 1] as number) * (1 + 1e-9));
    }
    expect(fit.energyReduction).toBeGreaterThan(0.5);
    expect(fit.handles).toEqual([
      { handle: 0, vertices: 90, maxMove: expect.any(Number) },
      { handle: 1, vertices: 90, maxMove: expect.any(Number) },
    ]);
    const fair = info(steps.find((s) => s.entry.op === 'smooth.implicit'));
    expect(fair.curvatureVarianceAfter as number).toBeLessThan(fair.curvatureVarianceBefore as number);
    expect((fair.volumeAfter as number) / (fair.volumeBefore as number)).toBeCloseTo(1, 9);
  });

  it('lands both cuffs on the posed joints, which the plain bend misses (falsifier)', () => {
    const { steps } = recorded();
    const blank = steps.find((s) => s.entry.op === 'markSharp')?.snapshot as Uint8Array;
    const fits = compareFits(blank);
    expect(fits.arap.elbowCuffError).toBeLessThan(1e-9);
    expect(fits.arap.wristCuffError).toBeLessThan(1e-9);
    expect(fits.bend.elbowCuffError).toBeGreaterThan(0.03);
    expect(fits.bend.wristCuffError).toBeGreaterThan(0.03);
    expect(fits.arap.meanEdgeStrain).toBeLessThan(fits.bend.meanEdgeStrain);
  });

  it('is two closed sessions without errors; only curved quads are non-planar', () => {
    const { m, recording } = recorded();
    for (const session of [m, recording.sessions.get('bent') as Model]) {
      const report = session.validate();
      expect(report.closed).toBe(true);
      expect(report.issues.filter((i) => i.code !== 'face-nonplanar')).toEqual([]);
    }
    expect(identity(m)).toMatchObject({ faces: 574, labels: ['guard', 'wall', 'panel', 'plate'] });
    expect(identity(m).plate).toBe(identity(m).trim);
  });

  it('exports the fitted guard', () => {
    const out = buildForearm().finish({ key: 'forearm', normals: { mode: 'autoSmooth', angle: 35 } });
    if (!out.ok) throw out.error;
    expect(Object.keys(out.value)).toEqual(['mesh/forearm']);
  });

  it('keeps every label and region count across the declared parameter range', { timeout: 120000 }, () => {
    const base = identity(buildForearm());
    for (const p of pack.parameters as readonly { name: keyof ForearmParameters; minimum: number; maximum: number }[]) {
      for (const value of [p.minimum, p.maximum]) {
        const variant = buildForearm({ ...FOREARM_DEFAULTS, [p.name]: value });
        expect([p.name, value, variant.poisoned?.code]).toEqual([p.name, value, undefined]);
        expect(identity(variant)).toEqual(base);
        const warnings = variant.journal.flatMap((e) => e.diagnostics ?? []).filter((d) => d.severity === 'warn');
        expect([p.name, value, warnings]).toEqual([p.name, value, []]);
      }
    }
  });
});
