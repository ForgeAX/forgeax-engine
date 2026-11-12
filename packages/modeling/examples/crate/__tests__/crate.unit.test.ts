import { fileURLToPath } from 'node:url';
import { definePackageId, executePackBuild } from '@forgeax/engine-pack/source';
import { type Model, model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { triangleSet } from '../../../src/__tests__/contract';
import { buildCrate, CRATE_DEFAULTS } from '../crate';
import pack from '../crate.pack';
import { attachSourceLines, recordingSessions } from '../../case/record';

const SOURCE = fileURLToPath(new URL('../crate.ts', import.meta.url));

function identity(m: Model) {
  const inspection = m.inspect();
  return {
    labels: inspection.labels,
    tags: Object.fromEntries(inspection.tags.map((t) => [t, m.count(sel.tag(t))])),
    materials: Object.fromEntries(inspection.materials.map((s) => [s, m.count(sel.material(s))])),
  };
}

describe('C-001 hard-surface prop crate', () => {
  it('builds without failure and its history maps onto the source line by line', () => {
    const recording = recordingSessions();
    const crate = buildCrate(CRATE_DEFAULTS, recording.session);
    expect(crate.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.length).toBeGreaterThanOrEqual(30);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    expect(new Set(steps.map((s) => s.session))).toEqual(
      new Set(['handle', 'rivet', 'lidPlate', 'hinge', 'crate']),
    );
  });

  it('validates with no errors and no confirmed self-intersection', () => {
    const report = buildCrate().validate();
    expect(report.pass).toBe(true);
    expect(
      report.issues.filter((i) => i.code === 'self-intersection' && i.detail.certainty === 'confirmed'),
    ).toEqual([]);
    expect(report.issues.filter((i) => i.severity === 'warn')).toEqual([]);
  });

  it('keeps every label, role, tag and material region when upstream sizes change', () => {
    const base = buildCrate();
    const variant = buildCrate({ width: 1.1, height: 0.65, depth: 0.6 });
    expect(identity(variant)).toEqual(identity(base));
    for (const m of [base, variant]) {
      expect(m.count(sel.createdBy('recess', 'top'))).toBe(4);
      expect(m.count(sel.createdBy('recess', 'top').and(sel.facing('+x').or(sel.facing('-x'))))).toBe(2);
      expect(m.count(sel.createdBy('lid-boss', 'top').and(sel.facing('+y')).one())).toBe(1);
      expect(m.count(sel.createdBy('skirt', 'top').and(sel.facing('-y')))).toBe(4);
    }
  });

  it('exports, lifts and re-exports to the same triangles', () => {
    const first = buildCrate().toMesh({ normals: { mode: 'weighted' } });
    if (!first.ok) throw first.error;
    const lifted = model();
    expect(lifted.lift(first.value.mesh).status).toBe('ok');
    const again = lifted.toMesh({ normals: { mode: 'weighted' } });
    if (!again.ok) throw again.error;
    expect(triangleSet(again.value.mesh)).toEqual(triangleSet(first.value.mesh));
    expect(again.value.report.materialSlots).toEqual(first.value.report.materialSlots);
  });

  it('is an ordinary Pack build with a mesh/crate output', async () => {
    const result = await executePackBuild(pack, {
      packageId: definePackageId('01900000-0000-7000-8000-0000000c0001'),
      readByGuid: async () => {
        throw new Error('the crate reads no other asset');
      },
      values: { ...CRATE_DEFAULTS },
    });
    expect(result.ok && Object.keys(result.value)).toEqual(['mesh/crate']);
  });
});
