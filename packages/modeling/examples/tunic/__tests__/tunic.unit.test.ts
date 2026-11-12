import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildTunic, TUNIC } from '../tunic';

describe('C-113 tunic (artist editing tools)', () => {
  it('builds with every operation ok and validates without errors', () => {
    const m = buildTunic();
    expect(m.poisoned).toBeUndefined();
    expect(m.journal.map((e) => e.op)).toEqual([
      'revolve',
      'translate',
      'layer',
      'cylinder',
      'shrinkwrap',
      'knife',
      'extrude',
      'knife',
      'uv.project',
    ]);
    const report = m.validate();
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(m.finish({ key: 'tunic' }).ok).toBe(true);
    const layer = m.journal[2]?.roles ?? {};
    expect(layer.inner).toBe(layer.layer);
    expect(m.count(sel.createdBy('neckline', 'inside'))).toBeGreaterThan(0);
    expect(m.count(sel.edges.seam())).toBeGreaterThan(0);
  });

  it('the wrapped waist band sits one gap off the hips', () => {
    const m = buildTunic();
    const mesh = m.editMesh;
    const top = sel
      .tag('skirt')
      .toVerts('touching')
      .evaluate(mesh)
      .filter((v) => mesh.position(v)[1] > 0.17);
    expect(top.length).toBeGreaterThan(0);
    const info = m.journal[4]?.diagnostics?.find((d) => d.severity === 'info')?.detail;
    expect(info).toMatchObject({ missed: 0 });
    expect(TUNIC.gap).toBe(0.004);
  });

  it('is deterministic', () => {
    expect(buildTunic().snapshot()).toEqual(buildTunic().snapshot());
  });
});
