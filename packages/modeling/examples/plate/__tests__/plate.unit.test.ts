import { fileURLToPath } from 'node:url';
import * as exact from '@forgeax/engine-modeling/brep';
import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildPlate, PLATE_DEFAULTS, PLATE_EXPORT, PLATE_JOB, PLATE_SLOTS } from '../plate';
import pack from '../plate.pack';

const SOURCE = fileURLToPath(new URL('../plate.ts', import.meta.url));

describe('C-700 steps 1 to 3: the exact plate', () => {
  it('records the three steps on their source lines; per-step renders start at fromShape', () => {
    const recording = recordingSessions({ exact });
    const plate = buildPlate(PLATE_DEFAULTS, recording.session);
    expect(plate.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.map((s) => s.entry.op)).toEqual(['brep.box', 'fromShape', 'assign', 'assign']);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    // The build step changes no face (D-P2-6); the first mesh state is fromShape.
    expect(steps.map((s) => s.faces)).toEqual([0, 6, 6, 6]);
  });

  it('step 1 is the exact box buildPlate produced: bounds, volume and every face area', () => {
    const { width, depth, thickness } = PLATE_DEFAULTS;
    const shape = buildPlate().shape('plate');
    if (shape === undefined) throw new Error('buildPlate leaves no Shape named plate');
    expect(exact.validate(shape).issues).toEqual([]);
    const measure = exact.measure(shape);
    if (!measure.ok) throw measure.error;
    expect(measure.value.volume).toBeCloseTo(width * thickness * depth, 12);
    expect(measure.value.area).toBeCloseTo(2 * (width * thickness + width * depth + thickness * depth), 12);
    expect(measure.value.faces.map((f) => f.area).sort((a, b) => a - b)).toEqual(
      [thickness * depth, thickness * depth, width * thickness, width * thickness, width * depth, width * depth]
        .sort((a, b) => a - b)
        .map((a) => expect.closeTo(a, 12)),
    );
    const extent = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const v of shape.vertices) {
      for (let k = 0; k < 3; k++) {
        extent[k] = Math.min(extent[k] as number, v.p[k] as number);
        extent[k + 3] = Math.max(extent[k + 3] as number, v.p[k] as number);
      }
    }
    expect([0, 1, 2].map((k) => (extent[k + 3] as number) - (extent[k] as number))).toEqual([
      expect.closeTo(width, 12),
      expect.closeTo(thickness, 12),
      expect.closeTo(depth, 12),
    ]);
  });

  it('the exported mesh has the declared extents along x, y and z', () => {
    const { width, depth, thickness } = PLATE_DEFAULTS;
    const exported = buildPlate({ width: 0.3, depth: 0.2, thickness: 0.02 }).toMesh(PLATE_EXPORT);
    if (!exported.ok) throw exported.error;
    const position = exported.value.mesh.attributes.position as Float32Array;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < position.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3] as number, position[i] as number);
      hi[i % 3] = Math.max(hi[i % 3] as number, position[i] as number);
    }
    expect([0, 1, 2].map((k) => (hi[k] as number) - (lo[k] as number))).toEqual([
      expect.closeTo(0.3, 6),
      expect.closeTo(0.02, 6),
      expect.closeTo(0.2, 6),
    ]);
    expect(width).not.toBe(0.3);
    expect(depth).not.toBe(0.2);
    expect(thickness).not.toBe(0.02);
  });

  it('step 2 meshes six planar faces that keep the Shape label and role', () => {
    const plate = buildPlate();
    expect(plate.editMesh.faceCount).toBe(6);
    expect(plate.inspect().labels.map((l) => l.label).sort()).toEqual(['plate.nx', 'plate.ny', 'plate.nz', 'plate.px', 'plate.py', 'plate.pz']);
    expect(plate.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('step 3 puts the large faces and the rim in their own slots, face by face', () => {
    const plate = buildPlate();
    expect(plate.count(sel.material(PLATE_SLOTS.face))).toBe(2);
    expect(plate.count(sel.material(PLATE_SLOTS.rim))).toBe(4);
    const slotOf: Record<string, string> = {
      'plate.py': PLATE_SLOTS.face,
      'plate.ny': PLATE_SLOTS.face,
      'plate.px': PLATE_SLOTS.rim,
      'plate.nx': PLATE_SLOTS.rim,
      'plate.pz': PLATE_SLOTS.rim,
      'plate.nz': PLATE_SLOTS.rim,
    };
    for (const [label, slot] of Object.entries(slotOf)) {
      expect(plate.count(sel.createdBy(label)), label).toBe(1);
      expect(plate.count(sel.createdBy(label).and(sel.material(slot))), label).toBe(1);
    }
    const exported = plate.toMesh(PLATE_EXPORT);
    if (!exported.ok) throw exported.error;
    expect(exported.value.mesh.submeshes).toHaveLength(2);
  });

  it('the job publishes the plate-c700 name and the 40 degree auto-smooth export', () => {
    expect(PLATE_JOB.name).toBe('plate-c700');
    expect(PLATE_JOB.export).toEqual({ normals: { mode: 'autoSmooth', angle: 40 } });
    const exported = buildPlate().toMesh(PLATE_JOB.export);
    if (!exported.ok) throw exported.error;
    expect((exported.value.mesh.attributes.position as Float32Array).length / 3).toBe(24);
  });

  it('textures every face at one texel density, in one unit cell, without overlap', () => {
    const plate = buildPlate();
    const exported = plate.toMesh(PLATE_EXPORT);
    if (!exported.ok) throw exported.error;
    const mesh = exported.value.mesh;
    const position = mesh.attributes.position as Float32Array;
    const uv = mesh.attributes.uv as Float32Array;
    const indices = mesh.indices as ArrayLike<number>;
    expect(indices.length / 3).toBe(12);
    const densities: number[] = [];
    // Chart box of each quad (two consecutive triangles share one face).
    const boxes: [number, number, number, number][] = [];
    for (let t = 0; t < 12; t++) {
      const [a, b, c] = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]] as [number, number, number];
      const p = (i: number) => [position[i * 3], position[i * 3 + 1], position[i * 3 + 2]] as [number, number, number];
      const q = (i: number) => [uv[i * 2], uv[i * 2 + 1]] as [number, number];
      const area3 = triangleArea3(p(a), p(b), p(c));
      const [ua, ub, uc] = [q(a), q(b), q(c)];
      const area2 = Math.abs((ub[0] - ua[0]) * (uc[1] - ua[1]) - (uc[0] - ua[0]) * (ub[1] - ua[1])) / 2;
      densities.push(Math.sqrt(area2 / area3));
      const box = boxes[Math.floor(t / 2)] ?? [Infinity, Infinity, -Infinity, -Infinity];
      for (const [u, v] of [ua, ub, uc]) {
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        box[0] = Math.min(box[0], u);
        box[1] = Math.min(box[1], v);
        box[2] = Math.max(box[2], u);
        box[3] = Math.max(box[3], v);
      }
      boxes[Math.floor(t / 2)] = box;
    }
    const mean = densities.reduce((s, d) => s + d, 0) / densities.length;
    for (const d of densities) expect(Math.abs(d - mean) / mean).toBeLessThan(1e-4);
    expect(boxes).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      for (let j = i + 1; j < 6; j++) {
        const [a, b] = [boxes[i], boxes[j]] as [number[], number[]];
        const apart = (a[2] as number) < (b[0] as number) || (b[2] as number) < (a[0] as number) || (a[3] as number) < (b[1] as number) || (b[3] as number) < (a[1] as number);
        expect(apart, `charts ${i} and ${j} overlap`).toBe(true);
      }
    }
  });

  it('builds at both ends of the declared parameter range', () => {
    const ends = (pick: 'minimum' | 'maximum') =>
      Object.fromEntries((pack.parameters as readonly { name: string; minimum: number; maximum: number }[]).map((p) => [p.name, p[pick]])) as never;
    for (const p of [ends('minimum'), ends('maximum')]) {
      const plate = buildPlate(p);
      expect([p, plate.poisoned?.code]).toEqual([p, undefined]);
      expect(plate.editMesh.faceCount).toBe(6);
      expect(plate.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  });

  it('is byte-identical on repeat', () => {
    const a = buildPlate().snapshot();
    const b = buildPlate().snapshot();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

function triangleArea3(a: readonly number[], b: readonly number[], c: readonly number[]): number {
  const u = [(b[0] as number) - (a[0] as number), (b[1] as number) - (a[1] as number), (b[2] as number) - (a[2] as number)] as [number, number, number];
  const v = [(c[0] as number) - (a[0] as number), (c[1] as number) - (a[1] as number), (c[2] as number) - (a[2] as number)] as [number, number, number];
  return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
}
