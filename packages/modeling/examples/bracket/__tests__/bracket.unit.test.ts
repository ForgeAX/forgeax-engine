import { fileURLToPath } from 'node:url';
import { definePackageId, executePackBuild } from '@forgeax/engine-pack/source';
import { type Model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { BRACKET_DEFAULTS, buildBracket } from '../bracket';
import pack from '../bracket.pack';

const SOURCE = fileURLToPath(new URL('../bracket.ts', import.meta.url));
const BEVELS = ['fillet', 'boss-chamfer', 'slot-round', 'edge-round', 'boss-fillet'];

function regions(m: Model) {
  return Object.fromEntries(
    m.inspect().labels.map(({ label, roles }) => [label, Object.keys(roles).sort()]),
  );
}

describe('C-010 machined bracket (bevel case)', () => {
  it('builds without failure and its history maps onto the source line by line', () => {
    const recording = recordingSessions();
    const bracket = buildBracket(BRACKET_DEFAULTS, recording.session);
    expect(bracket.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.length).toBeGreaterThanOrEqual(6);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    expect(steps.filter((s) => s.entry.op === 'bevel').map((s) => s.entry.label)).toEqual(BEVELS);
  });

  it('validates closed with no errors and no warnings', () => {
    const report = buildBracket().validate();
    expect(report.pass).toBe(true);
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('clamps only the boss-foot fillet and reports its actual widths', () => {
    const bracket = buildBracket();
    const warnings = Object.fromEntries(
      bracket.journal
        .filter((e) => e.op === 'bevel')
        .map((e) => [e.label, (e.diagnostics ?? []).filter((d) => d.severity === 'warn').map((d) => d.detail)]),
    );
    expect(warnings).toMatchObject({ fillet: [], 'boss-chamfer': [], 'slot-round': [], 'edge-round': [] });
    const clamp = warnings['boss-fillet']?.[0] as { requested: number; clamped: number; minWidth: number };
    expect(clamp.clamped).toBe(4);
    expect(clamp.minWidth).toBeGreaterThan(0);
    expect(clamp.minWidth).toBeLessThan(clamp.requested);
    expect(bracket.count(sel.createdBy('fillet', 'bevel'))).toBe(6);
    expect(bracket.count(sel.createdBy('boss-chamfer', 'bevel'))).toBe(4);
  });

  it('keeps every bevel region when the parameters change', () => {
    const base = buildBracket();
    const variant = buildBracket({ length: 0.2, height: 0.08, thickness: 0.02, depth: 0.12, fillet: 0.004 });
    expect(variant.poisoned).toBeUndefined();
    expect(regions(variant)).toEqual(regions(base));
    // Strip counts are topological; patch faces may split differently where quads are non-planar.
    for (const m of [base, variant]) {
      for (const label of BEVELS) expect(m.count(sel.createdBy(label))).toBeGreaterThan(0);
      expect(m.count(sel.createdBy('fillet', 'bevel'))).toBe(6);
      expect(m.count(sel.createdBy('boss-chamfer', 'bevel'))).toBe(4);
      expect(m.count(sel.createdBy('boss', 'top').one())).toBe(1);
      expect(m.count(sel.createdBy('slot-cut', 'top').one())).toBe(1);
    }
  });

  it('builds closed and error-free at every corner of the declared parameter ranges', { timeout: 60000 }, () => {
    const ranges = (pack.parameters ?? []).map((d) => [d.name, d.minimum, d.maximum] as const);
    expect(ranges.map(([name]) => name).sort()).toEqual(Object.keys(BRACKET_DEFAULTS).sort());
    for (let mask = 0; mask < 1 << ranges.length; mask++) {
      const values = Object.fromEntries(
        ranges.map(([name, lo, hi], i) => [name, ((mask >> i) & 1) === 1 ? hi : lo]),
      ) as unknown as typeof BRACKET_DEFAULTS;
      const m = buildBracket(values);
      expect([values, m.poisoned?.code]).toEqual([values, undefined]);
      const report = m.validate();
      expect(report.closed).toBe(true);
      expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  });

  it('is an ordinary Pack build with a mesh/bracket output', async () => {
    const result = await executePackBuild(pack, {
      packageId: definePackageId('01900000-0000-7000-8000-0000000c0010'),
      readByGuid: async () => {
        throw new Error('the bracket reads no other asset');
      },
      values: { ...BRACKET_DEFAULTS },
    });
    expect(result.ok && Object.keys(result.value)).toEqual(['mesh/bracket']);
  });
});
