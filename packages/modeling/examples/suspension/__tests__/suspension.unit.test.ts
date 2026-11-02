import { fileURLToPath } from 'node:url';
import { definePackageId, executePackBuild } from '@forgeax/engine-pack/source';
import { type Model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildSuspension, isolated, SUSPENSION_DEFAULTS, SUSPENSION_VARIANT, SWEPT } from '../suspension';
import pack from '../suspension.pack';

const SOURCE = fileURLToPath(new URL('../suspension.ts', import.meta.url));
function regions(m: Model) {
  return Object.fromEntries(m.inspect().labels.map(({ label, roles }) => [label, Object.keys(roles).sort()]));
}

describe('C-104 double-wishbone suspension (sweep, loft and array case)', () => {
  it('builds without failure and its history maps onto the source line by line', () => {
    const recording = recordingSessions();
    const s = buildSuspension(SUSPENSION_DEFAULTS, recording.session);
    expect(s.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.length).toBeGreaterThanOrEqual(8);
    expect(steps.every((step) => step.entry.status === 'ok')).toBe(true);
    const ops = new Set(steps.map((step) => step.entry.op));
    for (const op of ['sweep', 'loft', 'array', 'revolve', 'append']) expect(ops.has(op)).toBe(true);
    expect(steps.filter((step) => step.entry.op === 'sweep').map((step) => step.entry.label)).toEqual([
      'upper-arm', 'lower-arm', 'lower-brace', 'steer-arm', 'spring', 'tie-rod', 'adjuster',
    ]);
    for (const step of steps) {
      expect((step.entry.diagnostics ?? []).filter((d) => d.severity === 'warn'), `${step.entry.op} ${step.entry.label}`).toEqual([]);
    }
  });

  it('closes every part, and each swept or lofted region is a clean solid on its own', () => {
    const s = buildSuspension();
    const report = s.validate();
    expect(report.pass).toBe(true);
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(report.issues.filter((i) => i.severity === 'warn').map((i) => i.code)).toEqual(['self-intersection']);
    for (const label of SWEPT) {
      const part = isolated(s, label);
      const alone = part.validate();
      expect(alone.closed, label).toBe(true);
      expect(alone.volume, label).toBeGreaterThan(0);
      expect(alone.issues.filter((i) => i.severity !== 'info'), label).toEqual([]);
    }
  });

  it('keeps sweep UVs along the path and box-projects only the primitives', () => {
    const s = buildSuspension();
    const mesh = s.editMesh;
    const spring = sel.createdBy('spring', 'side').evaluate(mesh);
    let longest = 0;
    for (const f of spring) for (const h of mesh.faceHalves(f)) longest = Math.max(longest, mesh.corner('uv0', h)?.[1] ?? 0);
    const coil = SUSPENSION_DEFAULTS.springTurns * Math.hypot(2 * Math.PI * 0.036, (0.42 - 0.108 - 2 * SUSPENSION_DEFAULTS.wire) / SUSPENSION_DEFAULTS.springTurns);
    expect(longest).toBeGreaterThan(coil * 0.99);
    expect(longest).toBeLessThan(coil * 1.001);
  });

  it('keeps every region and the array copy counts when the parameters change', () => {
    const base = buildSuspension();
    const variant = buildSuspension(SUSPENSION_VARIANT);
    expect(variant.poisoned).toBeUndefined();
    expect(regions(variant)).toEqual(regions(base));
    for (const m of [base, variant]) {
      expect(m.count(sel.createdBy('studs', 'copy'))).toBe(40);
      expect(m.count(sel.tag('studs:4'))).toBe(10);
      expect(m.count(sel.createdBy('upper-bushes', 'copy'))).toBe(64);
      expect(m.count(sel.createdBy('spring', 'start').one())).toBe(1);
      expect(m.count(sel.createdBy('upright', 'start').one())).toBe(1);
    }
    expect(variant.count(sel.createdBy('spring', 'side'))).toBeGreaterThan(base.count(sel.createdBy('spring', 'side')));
  });

  it('is an ordinary Pack build with a mesh/suspension output', async () => {
    const result = await executePackBuild(pack, {
      packageId: definePackageId('01900000-0000-7000-8000-0000000c0104'),
      readByGuid: async () => {
        throw new Error('the suspension reads no other asset');
      },
      values: { ...SUSPENSION_DEFAULTS },
    });
    expect(result.ok && Object.keys(result.value)).toEqual(['mesh/suspension']);
  });
});
