import { fileURLToPath } from 'node:url';
import { type Model, sel } from '@forgeax/engine-modeling';
import { PackageId } from '@forgeax/engine-pack';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildPauldron, PAULDRON_DEFAULTS, type PauldronParameters, RAISED, rigPauldron } from '../pauldron';
import pack from '../pauldron.pack';

const SOURCE = fileURLToPath(new URL('../pauldron.ts', import.meta.url));

function identity(m: Model) {
  return {
    faces: m.editMesh.faceCount,
    labels: m.inspect().labels.map((l) => l.label),
    spine: m.count(sel.createdBy('spine')),
    recess: m.count(sel.createdBy('recess', 'top')),
    plate: m.count(sel.tag('pauldron')),
    mount: m.count(sel.tag('collar')),
  };
}

function positions(mesh: MeshAsset): Float32Array {
  return mesh.attributes.position as Float32Array;
}

describe('C-014 subdivided shoulder armor rigged to the mech-gt skeleton', () => {
  it('builds every step ok and without warnings, mapped to its source line', () => {
    const recording = recordingSessions();
    const m = buildPauldron(PAULDRON_DEFAULTS, recording.session);
    expect(m.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.length).toBeGreaterThanOrEqual(8);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    expect(steps.flatMap((s) => s.entry.diagnostics ?? []).filter((d) => d.severity === 'warn')).toEqual([]);
    const ops = steps.map((s) => s.entry.op);
    for (const op of ['subdivide', 'lattice', 'taper', 'bend']) expect(ops).toContain(op);
    const subdivision = steps.find((s) => s.session === 'pauldron' && s.entry.op === 'subdivide');
    const job = subdivision?.entry.diagnostics?.find((d) => d.severity === 'info')?.detail;
    expect(job).toMatchObject({ backend: 'ts', quality: 'baseline', levels: 2, scheme: 'catmullClark' });
    const bend = steps.find((s) => s.entry.op === 'bend');
    const moved = bend?.entry.diagnostics?.find((d) => d.severity === 'info')?.detail;
    expect(moved?.maxDisplacement).toBeGreaterThan(0.2);
  });

  it('is two closed parts without errors; only curved quads are non-planar', () => {
    const m = buildPauldron();
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.code !== 'face-nonplanar')).toEqual([]);
    expect(identity(m)).toMatchObject({ faces: 2368, spine: 448, recess: 192, plate: 2112, mount: 256 });
  });

  it('binds the plate to shoulder-l and the mount to chest; poses move each part rigidly', () => {
    const r = rigPauldron(buildPauldron());
    const parts = r.parts();
    if (!parts.ok) throw parts.error;
    expect(parts.value.map((p) => [p.name, p.joint, p.faces, p.closed])).toEqual([
      ['pauldron', 'shoulder-l', 2112, true],
      ['mount', 'chest', 256, true],
    ]);
    const rest = r.toMesh({});
    const raised = r.toMesh(RAISED);
    if (!rest.ok) throw rest.error;
    if (!raised.ok) throw raised.error;
    expect(raised.value.pose.clamped).toEqual([]);
    const a = positions(rest.value.mesh);
    const b = positions(raised.value.mesh);
    expect(b.length).toBe(a.length);
    let moved = 0;
    for (let i = 0; i < a.length; i += 3) {
      if (Math.hypot((a[i] as number) - (b[i] as number), (a[i + 1] as number) - (b[i + 1] as number), (a[i + 2] as number) - (b[i + 2] as number)) > 0.01) moved++;
    }
    expect(moved).toBeGreaterThan(a.length / 3 / 2);
    const clear = r.interference(RAISED);
    if (!clear.ok) throw clear.error;
    expect(clear.value.confirmed).toBe(0);
  });

  it('exports the rig as a scene with one mesh per part', () => {
    const id = PackageId.parse('01900000-0000-7000-8000-0000000c0014');
    if (!id.ok) throw id.error;
    const out = rigPauldron(buildPauldron()).finish({ key: 'pauldron', packageId: id.value });
    if (!out.ok) throw out.error;
    expect(Object.keys(out.value).sort()).toEqual(['mesh/pauldron.mount', 'mesh/pauldron.pauldron', 'scene/pauldron']);
  });

  it('keeps every label, part and region count across the declared parameter range', { timeout: 120000 }, () => {
    const base = identity(buildPauldron());
    for (const p of pack.parameters as readonly { name: keyof PauldronParameters; minimum: number; maximum: number }[]) {
      for (const value of [p.minimum, p.maximum]) {
        const variant = buildPauldron({ ...PAULDRON_DEFAULTS, [p.name]: value });
        expect([p.name, value, variant.poisoned?.code]).toEqual([p.name, value, undefined]);
        expect(identity(variant)).toEqual(base);
        const warnings = variant.journal.flatMap((e) => e.diagnostics ?? []).filter((d) => d.severity === 'warn');
        expect([p.name, value, warnings]).toEqual([p.name, value, []]);
        expect(rigPauldron(variant).toMesh(RAISED).ok).toBe(true);
      }
    }
  });
});
