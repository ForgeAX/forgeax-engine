import { fileURLToPath } from 'node:url';
import { EDGE_SHARP, type Model, type OpReport, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { BOOT_DEFAULTS, type BootParameters, buildBoot, KNEE } from '../boot';
import pack from '../boot.pack';

const SOURCE = fileURLToPath(new URL('../boot.ts', import.meta.url));

type Metrics = Record<string, number>;
const metrics = (entry: OpReport) =>
  (entry.diagnostics?.find((d) => d.severity === 'info')?.detail as { metrics: Metrics }).metrics;

/** Edges between faces of different label (role changes inside one label do not count). */
function labelBorders(m: Model): { edges: number; sharp: number } {
  const mesh = m.editMesh;
  let edges = 0;
  let sharp = 0;
  for (const e of mesh.edges()) {
    const f = mesh.hFace[e * 2] as number;
    const g = mesh.hFace[e * 2 + 1] as number;
    if (f < 0 || g < 0 || mesh.fLabel[f] === mesh.fLabel[g]) continue;
    edges++;
    if (((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0) sharp++;
  }
  return { edges, sharp };
}

describe('C-108 voxel and remesh: the mech knee boot', () => {
  it('records every step on its source line; the voxel and remesh jobs report on the TS baseline', { timeout: 300000 }, () => {
    const recording = recordingSessions();
    const boot = buildBoot(BOOT_DEFAULTS, recording.session);
    expect(boot.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.length).toBeGreaterThanOrEqual(20);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    const jobs = steps.filter((s) => ['voxel.union', 'remesh', 'simplify'].includes(s.entry.op));
    expect(jobs.map((s) => s.entry.op)).toEqual(['voxel.union', 'remesh', 'simplify']);
    for (const step of jobs) {
      expect(step.entry.diagnostics?.find((d) => d.severity === 'info')?.detail).toMatchObject({ backend: 'ts', quality: 'baseline' });
      expect(step.entry.diagnostics?.filter((d) => d.severity === 'warn')).toEqual([]);
    }
    const [union, remesh, simplify] = jobs.map((s) => metrics(s.entry)) as [Metrics, Metrics, Metrics];
    // Nine overlapping rings melt into one sleeve on a 6 mm grid.
    expect(union.parts).toBe(9);
    expect(union.faces).toBeGreaterThan(20000);
    expect(remesh.hausdorff).toBeLessThan(0.005);
    expect(Math.abs(remesh.volumeChange as number)).toBeLessThan(0.01);
    expect(simplify.trianglesAfter).toBe(BOOT_DEFAULTS.budget);
    expect(simplify.hausdorff).toBeLessThan(0.005);
    expect(Math.abs(simplify.volumeChange as number)).toBeLessThan(0.002);
  });

  it('ends closed on the knee, with exact hard edges along every clamp label border', { timeout: 300000 }, () => {
    const boot = buildBoot();
    expect(boot.editMesh.faceCount).toBe(BOOT_DEFAULTS.budget);
    expect(boot.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(boot.inspect().labels.map((l) => l.label).sort()).toEqual(['boot', 'clamp']);
    expect(boot.count(sel.createdBy('clamp', 'top'))).toBeGreaterThan(0);
    expect(boot.count(sel.createdBy('clamp', 'side'))).toBeGreaterThan(0);
    expect(boot.count(sel.material('steel'))).toBe(boot.count(sel.createdBy('clamp')));
    const borders = labelBorders(boot);
    expect(borders.edges).toBeGreaterThan(100);
    expect(borders.sharp).toBe(borders.edges);
    const bounds = boot.bounds(sel.all());
    if (!bounds.ok) throw bounds.error;
    for (let k = 0; k < 3; k++) {
      const center = ((bounds.value.min[k] as number) + (bounds.value.max[k] as number)) / 2;
      expect(Math.abs(center - (KNEE[k] as number))).toBeLessThan(0.01);
    }
    const exported = boot.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } });
    expect(exported.ok).toBe(true);
  });

  it('builds at both ends of the declared parameter range', { timeout: 300000 }, () => {
    const ends = (pick: 'minimum' | 'maximum') =>
      Object.fromEntries(
        (pack.parameters as readonly { name: keyof BootParameters; minimum: number; maximum: number }[]).map((p) => [p.name, p[pick]]),
      ) as unknown as BootParameters;
    for (const p of [ends('minimum'), ends('maximum')]) {
      const boot = buildBoot(p);
      expect([p, boot.poisoned?.code]).toEqual([p, undefined]);
      expect(boot.editMesh.faceCount).toBe(p.budget);
      expect(labelBorders(boot).sharp).toBe(labelBorders(boot).edges);
      expect(boot.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  });
});
