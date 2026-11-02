import { describe, expect, it } from 'vitest';
import {
  buildSuspension,
  SUSPENSION_DEFAULTS,
  SUSPENSION_JOINTS,
  SUSPENSION_VARIANT,
} from '../suspension';
import { probeJoints, rangeProbes } from '../range';

const confirmed = (issues: readonly { code: string; severity: string }[]) =>
  issues.filter((i) => i.code === 'self-intersection' && i.severity === 'warn').length;

describe('C-104 as an assembly with declared joints (designed contact)', () => {
  it('validates clean at the default and the variant parameters', { timeout: 120000 }, () => {
    for (const p of [SUSPENSION_DEFAULTS, SUSPENSION_VARIANT]) {
      const report = buildSuspension(p).validate({ contacts: SUSPENSION_JOINTS });
      expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
      const fits = report.issues.find((i) => i.code === 'designed-contact');
      expect((fits?.detail as { fits: { status: string }[] }).fits.every((f) => f.status === 'within')).toBe(true);
    }
  });

  it('without the joints, or with one too tight, the nesting stays a confirmed crossing', {
    timeout: 120000,
  }, () => {
    const m = buildSuspension();
    expect(confirmed(m.validate().issues)).toBe(1);
    const tight = SUSPENSION_JOINTS.map((j) =>
      j.parts[1] === 'lower-brace' ? { ...j, tolerance: 0.001 } : j,
    );
    const report = m.validate({ contacts: tight });
    expect(confirmed(report.issues)).toBe(1);
    const fits = (report.issues.find((i) => i.code === 'designed-contact')?.detail as {
      fits: { parts: string[]; status: string }[];
    }).fits;
    expect(fits.find((f) => f.parts[1] === 'lower-brace')?.status).toBe('exceeded');
  });

  it('stays clean at every declared range endpoint and every corner of the ranges', { timeout: 600000 }, () => {
    const probes = rangeProbes();
    expect(probes).toHaveLength(8 + 16);
    for (const { probe, parameters } of probes) {
      const result = probeJoints(parameters);
      expect(result.confirmedCrossings, probe).toBe(0);
      expect(result.errors, probe).toBe(0);
      expect(result.warnings, probe).toEqual([]);
      expect(result.fits.filter((f) => f.status !== 'within'), probe).toEqual([]);
    }
  });
});
