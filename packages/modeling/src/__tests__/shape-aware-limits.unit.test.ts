import { describe, expect, it } from 'vitest';
import { triangleAspect } from '../geom';
import { EDGE_SEAM } from '../mesh';
import { type Model, model } from '../model';

function sphere(): Model {
  const m = model();
  m.sphere({ radius: 1, widthSegments: 32, heightSegments: 16 });
  return m;
}

function withSeam(): Model {
  const m = sphere();
  const mesh = m.editMesh;
  const e = mesh.edges()[100] as number;
  mesh.eFlags[e] = (mesh.eFlags[e] as number) | EDGE_SEAM;
  return m;
}

function withMaterials(): Model {
  const m = sphere();
  const mesh = m.editMesh;
  const steel = mesh.nameIndex(mesh.materialNames, 'steel');
  let n = 0;
  for (const f of mesh.faces()) if (n++ % 7 === 0) mesh.fMaterial[f] = steel;
  return m;
}

function fineBox(): Model {
  const m = model();
  m.box({ size: [1, 0.4, 2] });
  m.remesh(undefined, { targetEdgeLength: 0.05, iterations: 3 });
  return m;
}

function quality(m: Model) {
  const r = m.meshQuality();
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

function foldedEdges(m: Model): number {
  const mesh = m.editMesh;
  const normal = (f: number) => {
    const [a, b, c] = mesh.faceVertices(f).map((v) => mesh.position(v));
    if (a === undefined || b === undefined || c === undefined) return [0, 0, 0];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return [
      (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number),
      (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number),
      (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number),
    ];
  };
  const byEdge = new Map<string, number[]>();
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    for (let i = 0; i < 3; i++) {
      const x = vs[i] as number;
      const y = vs[(i + 1) % 3] as number;
      const key = `${Math.min(x, y)}:${Math.max(x, y)}`;
      byEdge.set(key, [...(byEdge.get(key) ?? []), f]);
    }
  }
  let folds = 0;
  for (const faces of byEdge.values()) {
    if (faces.length !== 2) continue;
    const a = normal(faces[0] as number);
    const b = normal(faces[1] as number);
    const dot =
      (a[0] as number) * (b[0] as number) +
      (a[1] as number) * (b[1] as number) +
      (a[2] as number) * (b[2] as number);
    if (
      dot <
      -0.5 *
        Math.hypot(...(a as [number, number, number])) *
        Math.hypot(...(b as [number, number, number]))
    )
      folds++;
  }
  return folds;
}

describe('K3 gate: a constrained mesh takes the unchanged path', () => {
  // Shape-aware work is for closed meshes with no seam, material, label or boundary edge; a
  // seam or a material on a closed sphere must give exactly the result of preserve.sharp: false,
  // which is the gate's own "off" path. The control shows the gate does change the plain sphere.
  const off = { preserve: { sharp: false } } as const;

  it('remesh: one seam edge or a material patch equals the gate-off result', () => {
    const run = (m: Model, o: object) => {
      expect(m.remesh(undefined, { targetEdgeLength: 0.12, iterations: 4, ...o }).status).toBe(
        'ok',
      );
      return m.snapshot();
    };
    expect(run(withSeam(), {})).toEqual(run(withSeam(), off));
    expect(run(withMaterials(), {})).toEqual(run(withMaterials(), off));
    expect(run(sphere(), {})).not.toEqual(run(sphere(), off));
  });

  it('simplify: one seam edge or a material patch equals the gate-off result', () => {
    const run = (m: Model, o: object) => {
      expect(m.simplify(undefined, { targetFaces: 200, ...o }).status).toBe('ok');
      return m.snapshot();
    };
    expect(run(withSeam(), {})).toEqual(run(withSeam(), off));
    expect(run(withMaterials(), {})).toEqual(run(withMaterials(), off));
    expect(run(sphere(), {})).not.toEqual(run(sphere(), off));
  });
});

describe('K3 shape-aware remesh output size (M-1)', () => {
  // Intended: with the shape-aware path each iteration splits until the halves are short too
  // (MAX_SPLIT_ROUNDS), so the mesh reaches targetEdgeLength instead of stopping after one
  // split pass. Size is set by area and targetEdgeLength; iterations only move it by ~10 %.
  const area = 6.4;
  const ideal = (edge: number) => area / (0.433 * edge * edge);
  const size = (edge: number, iterations: number) => {
    const m = model();
    m.box({ size: [1, 0.4, 2] });
    expect(m.remesh(undefined, { targetEdgeLength: edge, iterations }).status).toBe('ok');
    return quality(m).triangles;
  };

  it('is within 1.4x of an equilateral tiling at the requested edge length', () => {
    for (const edge of [0.1, 0.2, 0.5]) {
      const n = size(edge, 3);
      expect(n).toBeGreaterThan(ideal(edge));
      expect(n).toBeLessThan(1.4 * ideal(edge));
    }
  });

  it('is nearly independent of the iteration count', () => {
    const one = size(0.1, 1);
    for (const iterations of [2, 3, 6]) {
      expect(size(0.1, iterations) / one).toBeGreaterThan(0.85);
      expect(size(0.1, iterations) / one).toBeLessThan(1.15);
    }
  });
});

describe('K3 limits that hold per shape (M-2)', () => {
  // Measured on fine meshes (remesh 0.05 x 3 first). The numbers are for these shapes only.
  it('remesh of a sphere leaves under 1 % of triangles above aspect 6', () => {
    const m = sphere();
    expect(m.remesh(undefined, { targetEdgeLength: 0.05, iterations: 3 }).status).toBe('ok');
    expect(quality(m).aspect.over6).toBeLessThan(0.01);
  });

  it('remesh of a torus leaves under 4 % above aspect 6 (not the 3 % that holds for the box)', () => {
    const m = model();
    m.torus({ radius: 1, tube: 0.3, radialSegments: 32, tubularSegments: 16 });
    expect(m.remesh(undefined, { targetEdgeLength: 0.05, iterations: 3 }).status).toBe('ok');
    expect(quality(m).aspect.over6).toBeLessThan(0.04);
  });

  it('maxAspect 4 on three overlapping boxes holds p90 and over6 but not a worst-triangle bound', () => {
    const m = model();
    m.box({ size: [2, 0.6, 0.6] });
    m.box({ size: [0.6, 1.6, 0.6], center: [-0.7, 0.5, 0] });
    m.box({ size: [0.6, 1.6, 0.6], center: [0.7, 0.5, 0] });
    m.remesh(undefined, { targetEdgeLength: 0.05, iterations: 3 });
    expect(m.simplify(undefined, { targetFaces: 200, maxAspect: 4 }).status).toBe('ok');
    const q = quality(m);
    expect(q.aspect.p90).toBeLessThanOrEqual(4);
    expect(q.aspect.over6).toBeLessThan(0.01);
    // Slivers already in the input and off the collapse path stay: the worst one is 8.6 here,
    // so the box's bound of 6 does not carry over. Document, do not assert a tighter value.
    expect(q.aspect.max).toBeLessThan(12);
  });
});

describe('K3 aspect-relaxing flips (M-3)', () => {
  it('relaxing after each collapse keeps the worst simplify sliver bounded on a remeshed box', () => {
    const m = model();
    m.box({ size: [1, 0.4, 2] });
    m.remesh(undefined, { targetEdgeLength: 0.1, iterations: 3 });
    expect(m.simplify(undefined, { targetFaces: 150 }).status).toBe('ok');
    // 27.8 with the relax step, 179 without it.
    expect(quality(m).aspect.max).toBeLessThan(60);
  });

  it('simplify of a fine box leaves no folded edge pair (flip orientation check)', () => {
    const m = fineBox();
    expect(m.simplify(undefined, { targetFaces: 300 }).status).toBe('ok');
    expect(foldedEdges(m)).toBe(0);
  });

  it('a direction field remesh does not take the multi-round split path', () => {
    const m = model();
    m.box({ size: [1, 0.4, 2] });
    const r = m.remesh(undefined, {
      targetEdgeLength: 0.1,
      iterations: 3,
      direction: { guides: [{ flow: { around: { axis: [0, 1, 0], center: [0, 0, 0] } } }] },
    });
    expect(r.status).toBe('ok');
    // 628 triangles on the field path; 1466 if split rounds ran under an active metric.
    expect(quality(m).triangles).toBeLessThan(900);
  });

  it('triangleAspect of a triangle with a non-finite corner is infinite, never NaN', () => {
    expect(triangleAspect([0, 0, 0], [1, 0, 0], [Number.NaN, 1, 0])).toBe(Number.POSITIVE_INFINITY);
  });
});
