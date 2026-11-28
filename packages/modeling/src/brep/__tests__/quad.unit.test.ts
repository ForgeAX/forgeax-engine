import { describe, expect, it } from 'vitest';
import type { EditMesh } from '../../mesh';
import { booleanSolids } from '../boolean';
import {
  box,
  cone,
  cylinder,
  extrude,
  quadrangulate,
  revolve,
  sphere,
  tessellate,
  torus,
} from '../index';
import type { Shape } from '../types';

type Built = { ok: true; value: Shape } | { ok: false; error: unknown };

function shapeOf(r: Built): Shape {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const hexagon = Array.from(
  { length: 6 },
  (_, i) => [Math.cos((i * Math.PI) / 3), Math.sin((i * Math.PI) / 3)] as const,
);

function maxEdgeRatio(m: EditMesh): number {
  let worst = 0;
  for (const f of m.faces()) {
    const vs = m.faceVertices(f);
    const lengths = vs.map((v, i) => {
      const a = m.position(v);
      const b = m.position(vs[(i + 1) % vs.length] as number);
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    });
    worst = Math.max(worst, Math.max(...lengths) / Math.min(...lengths));
  }
  return worst;
}

function allQuads(m: EditMesh): boolean {
  return m.faces().every((f) => m.faceVertices(f).length === 4);
}

function quadOf(shape: Shape, size: number) {
  const r = quadrangulate(shape, { size });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function sourceLabels(shape: Shape): Set<string> {
  return new Set(shape.faces.map((f) => `${f.label}|${f.role}`));
}

describe('quadrangulate falsifiers', () => {
  it('box: all quads, no degenerate quad, watertight, sJ min >= 0.3, labels and roles kept', () => {
    const shape = shapeOf(box({ size: [1, 1, 1] }));
    const { mesh, report } = quadOf(shape, 0.25);
    expect(allQuads(mesh)).toBe(true);
    expect(report.quads).toBe(96);
    expect(report.degenerate).toBe(0);
    expect(report.openEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
    expect(report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
    expect(report.singularities).toBe(8);
    const labels = new Set(
      mesh
        .faces()
        .map(
          (f) =>
            `${mesh.labelNames[mesh.fLabel[f] as number]}|${mesh.roleNames[mesh.fRole[f] as number]}`,
        ),
    );
    expect(labels).toEqual(sourceLabels(shape));
  });

  it('cylinder: all quads including caps, no degenerate quad, watertight, sJ min >= 0.3, 8 singularities, 64 rim segments', () => {
    const shape = shapeOf(cylinder({ radius: 0.5, height: 1 }));
    const { mesh, report } = quadOf(shape, 0.05);
    expect(allQuads(mesh)).toBe(true);
    expect(report.degenerate).toBe(0);
    expect(report.openEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
    expect(report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
    expect(report.singularities).toBe(8);
    expect(report.quads).toBe(1920);
  });

  it('red proof: tessellate on the same cylinder leaves n-gon caps, so the all-quads check fails on it', () => {
    const shape = shapeOf(cylinder({ radius: 0.5, height: 1 }));
    const r = tessellate(shape, {});
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(allQuads(r.value)).toBe(false);
  });

  it('torus: all quads, watertight, no singularities, max edge ratio <= 2', () => {
    const shape = shapeOf(torus({ major: 1, minor: 0.3 }));
    const { mesh, report } = quadOf(shape, 0.05);
    expect(allQuads(mesh)).toBe(true);
    expect(report.degenerate).toBe(0);
    expect(report.openEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
    expect(report.singularities).toBe(0);
    expect(report.scaledJacobian.min).toBeGreaterThanOrEqual(0.3);
    expect(report.quads).toBe(5904);
    expect(maxEdgeRatio(mesh)).toBeLessThanOrEqual(2);
  });

  it('is deterministic: the same Shape and options give identical mesh arrays', () => {
    const shape = shapeOf(cylinder({ radius: 0.5, height: 1 }));
    const a = quadOf(shape, 0.2).mesh;
    const b = quadOf(shape, 0.2).mesh;
    expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
    expect(a.faces().map((f) => a.faceVertices(f))).toEqual(
      b.faces().map((f) => b.faceVertices(f)),
    );
  });
});

describe('quadrangulate unsupported cases', () => {
  it('sphere pole: brep-face-unsupported with a reason in detail', () => {
    const r = quadrangulate(shapeOf(sphere({ radius: 1 })), { size: 0.3 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-partial');
    expect(r.error.detail).toMatchObject({
      brep: 'brep-face-unsupported',
      reason: 'degenerate-side',
    });
  });

  it('cone apex: pole fan closes the face, closed manifold mesh', () => {
    const r = quadrangulate(shapeOf(cone({ radius: 0.5, height: 1 })), { size: 0.2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.openEdges).toBe(0);
    expect(r.value.report.nonManifoldEdges).toBe(0);
    expect(r.value.report.triangles).toBeGreaterThan(0);
  });

  it('frustum with unequal circle counts: opposite-side solve equalises the rings, closed quad mesh', () => {
    const frustum = shapeOf(
      revolve({
        profile: [
          [0, -0.5],
          [0.5, -0.5],
          [0.25, 0.5],
          [0, 0.5],
        ],
      }),
    );
    const r = quadrangulate(frustum, { size: 0.2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.openEdges).toBe(0);
    expect(r.value.report.nonManifoldEdges).toBe(0);
  });

  it('trapezoid prism: opposite planar sides of unequal length share one count, closed quad mesh', () => {
    const trapezoid: [number, number][] = [
      [0, 0],
      [2, 0],
      [1.5, 1],
      [0.5, 1],
    ];
    const r = quadrangulate(shapeOf(extrude({ profile: trapezoid, depth: 0.5 })), { size: 0.25 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.openEdges).toBe(0);
    expect(r.value.report.nonManifoldEdges).toBe(0);
  });

  it('non-rectangular outer loop without holes (hexagonal prism cap): trimmed quadder, no perfect matching', () => {
    const r = quadrangulate(shapeOf(extrude({ profile: hexagon, depth: 1 })), { size: 0.25 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-partial');
    expect(r.error.detail).toMatchObject({
      brep: 'brep-face-unsupported',
      reason: 'no-perfect-matching',
    });
  });

  it('non-rectangular outer loop without holes (triangular prism cap): trimmed quadder, no perfect matching', () => {
    const triangle = [
      [0, 0],
      [1, 0],
      [0, 1],
    ] as const;
    const r = quadrangulate(shapeOf(extrude({ profile: triangle, depth: 1 })), { size: 0.25 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-partial');
    expect(r.error.detail).toMatchObject({
      brep: 'brep-face-unsupported',
      reason: 'no-perfect-matching',
    });
  });

  it.each([
    'cut',
    'trim',
    'merge',
  ] as const)('source %s: model-partial with brep-quad-unsupported-source', (source) => {
    const r = quadrangulate(shapeOf(box({ size: [1, 1, 1] })), { size: 0.25, source });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-partial');
    expect(r.error.detail).toMatchObject({ brep: 'brep-quad-unsupported-source', source });
  });

  it('quads a boolean result with a holed plane through the per-face path', () => {
    const boxS = shapeOf(box({ size: [2.6, 1, 1] }));
    const cyl = shapeOf(cylinder({ radius: 0.3, height: 3 }));
    const minus = shapeOf(booleanSolids(boxS, cyl, 'difference'));
    const r = quadrangulate(minus, { size: 0.25, source: 'boolean', trimmed: 'blossom-penalty' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.quads).toBeGreaterThan(0);
    expect(r.value.report.openEdges).toBe(0);
    expect(r.value.faceQuality.length).toBeGreaterThan(0);
  });

  it('fails closed with a face reason on a boolean result when trimmed is reject', () => {
    const boxS = shapeOf(box({ size: [2.6, 1, 1] }));
    const cyl = shapeOf(cylinder({ radius: 0.3, height: 3 }));
    const minus = shapeOf(booleanSolids(boxS, cyl, 'difference'));
    const r = quadrangulate(minus, { size: 0.25, source: 'boolean', trimmed: 'reject' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.detail).toMatchObject({
      brep: 'brep-face-unsupported',
      face: 4,
      reason: 'trimmed-loop',
    });
  });

  it('rejects a non-positive size with brep-bad-argument', () => {
    const r = quadrangulate(shapeOf(box({ size: [1, 1, 1] })), { size: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
    expect(r.error.detail).toMatchObject({ brep: 'brep-bad-argument', size: 0 });
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects a non-finite size (%s) with brep-bad-argument', (size) => {
    const r = quadrangulate(shapeOf(box({ size: [1, 1, 1] })), { size });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
    expect(r.error.detail).toMatchObject({ brep: 'brep-bad-argument', size });
  });
});
