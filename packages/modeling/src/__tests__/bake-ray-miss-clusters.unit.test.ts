import { describe, expect, it } from 'vitest';
import { bakeMaps } from '../bake';
import { type Model, model } from '../model';

const step = (e0: number, e1: number, x: number) => Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));

function heightfield(
  f: (x: number, y: number) => number,
  n: number,
  skip: (x: number, y: number) => boolean = () => false,
): Model {
  const m = model();
  const mesh = m.editMesh;
  const ids: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -0.5 + i / n;
      const y = -0.5 + j / n;
      ids.push(mesh.addVertex(x, y, f(x, y)));
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (skip(-0.5 + (i + 0.5) / n, -0.5 + (j + 0.5) / n)) continue;
      const a = ids[j * (n + 1) + i] as number;
      const b = ids[j * (n + 1) + i + 1] as number;
      const c = ids[(j + 1) * (n + 1) + i + 1] as number;
      const d = ids[(j + 1) * (n + 1) + i] as number;
      mesh.addFace([a, b, c]);
      mesh.addFace([a, c, d]);
    }
  }
  return m;
}

function plate(): Model {
  const m = model();
  const mesh = m.editMesh;
  const f = mesh.addFace([
    mesh.addVertex(-0.5, -0.5, 0),
    mesh.addVertex(0.5, -0.5, 0),
    mesh.addVertex(0.5, 0.5, 0),
    mesh.addVertex(-0.5, 0.5, 0),
  ]);
  if (!f.ok) throw new Error('plate');
  for (const h of mesh.faceHalves(f.value)) {
    const p = mesh.position(mesh.hVert[h] as number);
    mesh.setCorner('uv0', h, [(p[0] as number) + 0.5, (p[1] as number) + 0.5]);
  }
  return m;
}

function bake(detail: Model, cage: { offset: number; maxRay: number }) {
  const r = bakeMaps({
    base: plate(),
    detail,
    maps: ['normal', 'height'],
    resolution: 64,
    filter: 'none',
    detailNormals: { mode: 'flat' },
    cage,
  });
  if (!r.ok) throw new Error(`${r.error.code} ${r.error.message}`);
  const g = r.value.provenance.groups[0];
  return {
    pass: r.value.pass,
    issues: r.value.issues.map((i) => i.code),
    clusters: g?.missClusters ?? [],
    samples: g?.samples,
    rayHits: g?.rayHits,
    nearest: g?.nearest,
    clipped: g?.clipped,
  };
}

describe('bake nearest-point fallback is reported as ray-miss clusters (M-B2)', () => {
  it('narrow deep blind hole (r 0.012, 0.3 deep) is flagged', () => {
    const out = bake(
      heightfield((x, y) => -0.3 * step(0.016, 0.012, Math.hypot(x, y)), 256),
      { offset: 0.01, maxRay: 0.05 },
    );
    expect(out.nearest ?? 0).toBeGreaterThan(0);
    expect(out.issues.some((c) => c === 'ray-miss' || c === 'cage-clip')).toBe(true);
    expect(out.pass).toBe(false);
    expect(out.clusters).toHaveLength(1);
    expect(out.clusters[0]?.samples).toBe(out.nearest);
  });

  it('through hole (0.06 m square of missing faces) is flagged', () => {
    const out = bake(
      heightfield(
        () => 0,
        128,
        (x, y) => Math.abs(x) < 0.03 && Math.abs(y) < 0.03,
      ),
      { offset: 0.01, maxRay: 0.1 },
    );
    expect(out.nearest ?? 0).toBeGreaterThan(0);
    expect(out.issues.some((c) => c === 'ray-miss' || c === 'cage-clip')).toBe(true);
    expect(out.pass).toBe(false);
    expect(out.clusters).toHaveLength(1);
    const box = out.clusters[0]?.bounds;
    expect(Math.abs((box?.min[0] ?? 1) + (box?.max[0] ?? 1))).toBeLessThan(0.03);
    expect(out.clusters[0]?.baseFaceCount).toBeGreaterThan(0);
  });

  it('a closed heightfield has no miss cluster and passes', () => {
    const out = bake(
      heightfield((x, y) => 0.01 * Math.sin(8 * x + y), 64),
      {
        offset: 0.05,
        maxRay: 0.2,
      },
    );
    expect(out.nearest).toBe(0);
    expect(out.clusters).toHaveLength(0);
    expect(out.issues).not.toContain('ray-miss');
  });

  it('control: wide deep blind hole with a long ray is flagged as cage-clip', () => {
    const out = bake(
      heightfield((x, y) => -0.3 * step(0.054, 0.05, Math.hypot(x, y)), 128),
      { offset: 0.01, maxRay: 0.2 },
    );
    expect(out.issues).toContain('cage-clip');
  });
});
