import { describe, expect, it } from 'vitest';
import { holedPlate, wavyPatch } from '../../../examples/trimmed-faces/models';
import { quadrangulateTrimmed } from '../../brep/quad-trimmed';
import type { TrimRing } from '../../brep/tessellate-trimmed';
import type { Surface } from '../../brep/types';
import type { P3 } from '../../brep/vec';
import { fieldQuads } from '../field-quads';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function reasonOf(r: { ok: boolean; error?: unknown }): [string, string | undefined] {
  const e = (r as { error: { code: string; detail?: { reason?: string } } }).error;
  return [e.code, e.detail?.reason];
}

const PLANE: Surface = {
  kind: 'plane',
  frame: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
} as unknown as Surface;

describe('quadrangulateTrimmed pairCost', () => {
  const ring = (): TrimRing => {
    const uv: [number, number][] = [];
    for (let i = 0; i < 4; i++) uv.push([i, 0]);
    for (let i = 0; i < 4; i++) uv.push([4, i]);
    for (let i = 0; i < 4; i++) uv.push([4 - i, 4]);
    for (let i = 0; i < 4; i++) uv.push([0, 4 - i]);
    return { uv, ids: uv.map((_, i) => i) };
  };
  const run = (pairCost: (c: readonly P3[]) => number) => {
    const r = ring();
    const store: P3[] = r.uv.map((q) => [q[0], q[1], 0]);
    return must(
      quadrangulateTrimmed(
        PLANE,
        [r],
        (id) => store[id] as P3,
        (p) => store.push(p) - 1,
        { angle: Math.PI / 6, maxPoints: 200, maxTriangles: 200, pairCost },
      ),
    ).quads.map((q) => q.join(','));
  };
  const centroidX = (c: readonly P3[]): number => c.reduce((s, p) => s + p[0], 0) / 4;

  it('steers which triangles pair, without changing admissibility', () => {
    const left = run((c) => (centroidX(c) < 2 ? 5 : 0));
    const right = run((c) => (centroidX(c) > 2 ? 5 : 0));
    expect(left.length).toBeGreaterThan(0);
    expect(left).not.toEqual(right);
  });
});

describe('fieldQuads', () => {
  it('meshes the holed plate quad-dominant with boundary rows, and reports the numbers', () => {
    const { shape } = holedPlate();
    const r = must(fieldQuads(shape, 0, { spacing: 4, fallback: 'triangles' }));
    const { report } = r;
    expect(report.rowsPeeled).toBe(2);
    expect(report.quads).toBeGreaterThan(10 * report.triangles);
    expect(report.minSj).toBeGreaterThanOrEqual(0.3);
    expect(r.mesh.faceCount).toBe(report.quads + report.triangles);
    expect(report.field.singularitiesInZone).toBe(0);
    expect(report.field.hardSegments).toBeGreaterThan(0);
  });

  it('meshes the wavy patch with every row quad bordering a loop', () => {
    const r = must(fieldQuads(wavyPatch(), 0, { spacing: 4, fallback: 'triangles' }));
    expect(r.report.rowQuads).toBe(r.rowQuadCount);
    expect(r.report.rowQuads).toBeGreaterThan(0);
    expect(r.report.minSj).toBeGreaterThanOrEqual(0.3);
    expect(r.report.alignment.loopEdges.max).toBeLessThan(25);
  });

  it('row rungs and loop edges sit near the loop-aligned field axes', () => {
    const r = must(fieldQuads(wavyPatch(), 0, { spacing: 4, fallback: 'triangles' }));
    expect(r.report.alignment.rows.mean).toBeLessThan(15);
    expect(r.report.alignment.rows.mean).toBeLessThan(22.5);
  });

  it('leaves no CDT fan across the plate: leftover triangles are a small share', () => {
    const { shape } = holedPlate();
    const coarse = must(
      fieldQuads(shape, 0, {
        spacing: 4,
        interiorSpacing: Number.POSITIVE_INFINITY,
        fallback: 'triangles',
      }),
    );
    const fine = must(fieldQuads(shape, 0, { spacing: 4, fallback: 'triangles' }));
    expect(fine.report.triangles / fine.report.quads).toBeLessThan(0.05);
    expect(fine.report.triangles / fine.report.quads).toBeLessThan(
      coarse.report.triangles / coarse.report.quads,
    );
  });

  it('is deterministic', () => {
    const a = must(fieldQuads(wavyPatch(), 0, { spacing: 5, fallback: 'triangles' }));
    const b = must(fieldQuads(wavyPatch(), 0, { spacing: 5, fallback: 'triangles' }));
    expect(a.report).toEqual(b.report);
  });

  it('fails closed with a named reason when the strict interior has no perfect matching', () => {
    const { shape } = holedPlate();
    expect(reasonOf(fieldQuads(shape, 0, { spacing: 4 }))).toEqual([
      'model-partial',
      'quad-no-perfect-matching',
    ]);
  });

  it('fails closed on a row layer that would fold', () => {
    const { shape } = holedPlate();
    expect(reasonOf(fieldQuads(shape, 0, { spacing: 20, fallback: 'triangles' }))[0]).toBe(
      'model-partial',
    );
  });

  it('rejects bad arguments', () => {
    const { shape } = holedPlate();
    expect(reasonOf(fieldQuads(shape, 9))).toEqual(['model-invalid-argument', 'unknown-face']);
    expect(reasonOf(fieldQuads(shape, 0, { rows: 0 }))).toEqual([
      'model-invalid-argument',
      'bad-rows',
    ]);
    expect(reasonOf(fieldQuads(shape, 0, { spacing: -1 }))).toEqual([
      'model-invalid-argument',
      'bad-spacing',
    ]);
    expect(reasonOf(fieldQuads(shape, 0, { alignmentWeight: -1 }))).toEqual([
      'model-invalid-argument',
      'bad-weight',
    ]);
  });
});
