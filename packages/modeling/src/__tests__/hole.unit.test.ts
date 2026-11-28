import { describe, expect, it } from 'vitest';
import { cos, sin } from '../dmath';
import { meshVolume } from '../geom';
import { type Model, model } from '../model';
import { sel } from '../selectors';
import { specOf, threads } from '../threads';

const PLATE: [number, number, number] = [0.1, 0.02, 0.1];

function plate(size: [number, number, number] = PLATE): Model {
  const m = model();
  m.box({ size, label: 'plate' });
  return m;
}

const top = sel.facing('+y');
const prism = (r: number, n: number, h: number): number =>
  0.5 * n * r * r * sin((2 * Math.PI) / n) * h;
const frustum = (r0: number, r1: number, n: number, h: number): number =>
  (h / 3) * (prism(r0, n, 1) + prism(r1, n, 1) + Math.sqrt(prism(r0, n, 1) * prism(r1, n, 1)));

function rolesOf(m: Model): Record<string, number> {
  const mesh = m.editMesh;
  const out: Record<string, number> = {};
  for (const f of mesh.faces()) {
    if (mesh.labelNames[mesh.fLabel[f] as number] !== 'hole') continue;
    const role = String(mesh.roleNames[mesh.fRole[f] as number]);
    out[role] = (out[role] ?? 0) + 1;
  }
  return out;
}

describe('m.hole volumes match the analytic cutter', () => {
  const v0 = PLATE[0] * PLATE[1] * PLATE[2];
  const n = 24;

  it('simple blind', () => {
    const m = plate();
    const r = m.hole(top, { kind: 'simple', diameter: 0.01, depth: 0.008, centers: [[0, 0]] });
    expect(r.status).toBe('ok');
    expect(meshVolume(m.editMesh)).toBeCloseTo(v0 - prism(0.005, n, 0.008), 12);
    expect(rolesOf(m)).toEqual({ 'hole-wall': n, 'hole-floor': 1 });
  });

  it('simple through has no floor', () => {
    const m = plate();
    expect(
      m.hole(top, { kind: 'simple', diameter: 0.01, depth: 'through', centers: [[0.02, -0.01]] })
        .status,
    ).toBe('ok');
    expect(meshVolume(m.editMesh)).toBeCloseTo(v0 - prism(0.005, n, PLATE[1]), 12);
    expect(rolesOf(m)['hole-floor']).toBeUndefined();
  });

  it('counterbore', () => {
    const m = plate();
    const r = m.hole(top, {
      kind: 'counterbore',
      diameter: 0.006,
      counterbore: { diameter: 0.012, depth: 0.005 },
      depth: 'through',
      centers: [[0, 0]],
    });
    expect(r.status).toBe('ok');
    expect(meshVolume(m.editMesh)).toBeCloseTo(
      v0 - prism(0.006, n, 0.005) - prism(0.003, n, PLATE[1] - 0.005),
      12,
    );
    expect(rolesOf(m)).toEqual({ counterbore: 2 * n, 'hole-wall': n });
  });

  it('countersink', () => {
    const m = plate();
    const r = m.hole(top, {
      kind: 'countersink',
      diameter: 0.006,
      countersink: { diameter: 0.012 },
      depth: 0.01,
      centers: [[0, 0]],
    });
    expect(r.status).toBe('ok');
    const cone = 0.003;
    expect(meshVolume(m.editMesh)).toBeCloseTo(
      v0 - frustum(0.003, 0.006, n, cone) - prism(0.003, n, 0.01 - cone),
      12,
    );
    expect(rolesOf(m)).toEqual({ countersink: n, 'hole-wall': n, 'hole-floor': 1 });
  });

  it('tapped hole bores the tap drill', () => {
    const m = plate();
    const t = specOf('M8');
    expect(
      m.hole(top, { kind: 'tapped', thread: 'M8', depth: 0.012, centers: [[0, 0]] }).status,
    ).toBe('ok');
    expect(meshVolume(m.editMesh)).toBeCloseTo(v0 - prism(t.tapDrill / 2, n, 0.012), 12);
  });
});

describe('m.hole errors', () => {
  it('rejects an unknown designation with the closed code', () => {
    const m = plate();
    const r = m.hole(top, {
      kind: 'tapped',
      thread: 'M7' as 'M8',
      depth: 0.01,
      centers: [[0, 0]],
    });
    expect(r.error?.code).toBe('model-invalid-argument');
    expect(r.error?.detail).toMatchObject({ option: 'thread', value: 'M7' });
  });

  it('rejects a blind hole deeper than the solid', () => {
    const m = plate();
    const r = m.hole(top, { kind: 'simple', diameter: 0.01, depth: 0.05, centers: [[0, 0]] });
    expect(r.error?.code).toBe('model-precondition');
    expect(r.error?.detail).toMatchObject({ reason: 'hole-through' });
  });

  it('rejects a thread that leaves no wall', () => {
    const m = plate();
    const r = m.hole(top, { kind: 'tapped', thread: 'M8', depth: 0.01, centers: [[0.048, 0]] });
    expect(r.error?.code).toBe('model-precondition');
    expect(r.error?.detail).toMatchObject({ reason: 'tap-wall' });
  });

  it('rejects bad options', () => {
    for (const bad of [
      { kind: 'simple', diameter: -1, depth: 0.01, centers: [[0, 0]] },
      { kind: 'simple', diameter: 0.01, depth: 0, centers: [[0, 0]] },
      { kind: 'simple', diameter: 0.01, depth: 0.01, centers: [] },
      {
        kind: 'simple',
        diameter: 0.01,
        depth: 0.01,
        centers: [
          [0, 0],
          [0.005, 0],
        ],
      },
      { kind: 'bolt', diameter: 0.01, depth: 0.01, centers: [[0, 0]] },
      {
        kind: 'counterbore',
        diameter: 0.01,
        counterbore: { diameter: 0.008, depth: 0.004 },
        depth: 0.01,
        centers: [[0, 0]],
      },
    ] as const) {
      const m = plate();
      const r = m.hole(top, bad as never);
      expect(r.error?.code).toBe('model-invalid-argument');
    }
  });
});

describe('catalogue', () => {
  it('looks up every designation to its published facts', () => {
    const all = threads.all();
    expect(all.length).toBeGreaterThan(100);
    for (const d of all) {
      const t = threads.lookup(d);
      expect(t.ok).toBe(true);
      if (!t.ok) continue;
      expect(t.value.designation).toBe(d);
      expect(t.value.tapDrill).toBeLessThan(t.value.major);
      expect(t.value.pitch).toBeGreaterThan(0);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it('matches standard values', () => {
    expect(specOf('M8')).toMatchObject({ major: 0.008, pitch: 0.00125, tapDrill: 0.00675 });
    expect(specOf('M1.6').pitch).toBeCloseTo(0.00035, 12);
    expect(specOf('M64').pitch).toBeCloseTo(0.006, 12);
    expect(specOf('1/4-20').major).toBeCloseTo(0.00635, 9);
    expect(specOf('1/4-20').pitch).toBeCloseTo(0.0254 / 20, 9);
    expect(specOf('#10-32').major).toBeCloseTo(0.19 * 0.0254, 6);
    expect(specOf('G1/8')).toMatchObject({ family: 'g', flankAngle: 55 });
    expect(specOf('G1/8').major).toBeCloseTo(0.009728, 6);
    expect(specOf('G1/8').pitch).toBeCloseTo(0.0254 / 28, 9);
    expect(specOf('Rp1/8').family).toBe('rp');
    expect(specOf('M8').flankAngle).toBe(60);
  });
});

describe('property: volume drops by the analytic cutters', () => {
  function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('random holes on a plate', () => {
    const rand = prng(20261102);
    for (let trial = 0; trial < 12; trial++) {
      const m = plate([0.2, 0.03, 0.2]);
      const v0 = meshVolume(m.editMesh);
      const count = 1 + Math.floor(rand() * 3);
      const segs = 8 + 4 * Math.floor(rand() * 5);
      const centers: [number, number][] = [];
      const radius = 0.006 + 0.004 * rand();
      for (let k = 0; k < count; k++) {
        centers.push([-0.07 + 0.07 * k + 0.01 * (rand() - 0.5), 0.05 * (rand() - 0.5)]);
      }
      const depth = 0.005 + 0.02 * rand();
      const r = m.hole(top, {
        kind: 'simple',
        diameter: 2 * radius,
        depth,
        centers,
        segments: segs,
      });
      expect(r.status).toBe('ok');
      expect(meshVolume(m.editMesh)).toBeCloseTo(v0 - count * prism(radius, segs, depth), 11);
    }
  });
});

describe('frame', () => {
  it('a +Z face reads centers as world (x, y)', () => {
    const m = plate([0.1, 0.1, 0.02]);
    expect(
      m.hole(sel.facing('+z'), {
        kind: 'simple',
        diameter: 0.01,
        depth: 'through',
        centers: [[0.03, -0.02]],
      }).status,
    ).toBe('ok');
    const mesh = m.editMesh;
    const xs = mesh
      .vertices()
      .map((v) => mesh.position(v))
      .filter((p) => Math.abs(p[2] - 0.01) < 1e-9);
    const hole = xs.filter((p) => Math.hypot(p[0] - 0.03, p[1] + 0.02) < 0.0051);
    expect(hole.length).toBeGreaterThanOrEqual(24);
    expect(hole.length).toBeLessThanOrEqual(26);
    expect(cos(0)).toBe(1);
  });
});
