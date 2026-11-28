import { describe, expect, it } from 'vitest';
import { PATTERN_CASES } from '../../../examples/brep-pattern/render';
import { quadrangulate, scaledJacobian } from '../quad';
import type { P3 } from '../vec';

function run(id: string, dominantSjFloor?: boolean) {
  const make = PATTERN_CASES[id];
  if (make === undefined) throw new Error(`${id} missing`);
  const shape = make().shape;
  const r = quadrangulate(shape, {
    size: 0.8,
    trimmed: 'quad-dominant',
    ...(dominantSjFloor === undefined ? {} : { dominantSjFloor }),
  });
  if (!r.ok) throw new Error(`${id} failed: ${r.error.code}`);
  const mesh = r.value.mesh;
  let quadMin = Number.POSITIVE_INFINITY;
  let minAngle = Number.POSITIVE_INFINITY;
  for (const f of mesh.faces()) {
    const pts = mesh.faceVertices(f).map((v) => mesh.position(v) as P3);
    if (pts.length === 4) quadMin = Math.min(quadMin, scaledJacobian(pts));
    else if (pts.length === 3) minAngle = Math.min(minAngle, triMinAngle(pts));
  }
  return { report: r.value.report, quadMin, minAngle };
}

function triMinAngle(p: readonly P3[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const a = p[i] as P3;
    const b = p[(i + 1) % 3] as P3;
    const c = p[(i + 2) % 3] as P3;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const d =
      (u[0] as number) * (w[0] as number) +
      (u[1] as number) * (w[1] as number) +
      (u[2] as number) * (w[2] as number);
    const lu = Math.hypot(u[0] as number, u[1] as number, u[2] as number);
    const lw = Math.hypot(w[0] as number, w[1] as number, w[2] as number);
    min = Math.min(min, Math.acos(Math.max(-1, Math.min(1, d / (lu * lw)))));
  }
  return min;
}

describe('quad-dominant opt-in SJ pair floor on the flange', () => {
  it('floor off keeps the slivers (default unchanged)', () => {
    const off = run('bolt6');
    expect(off.quadMin).toBeLessThan(0.01);
    expect(off.report.quads).toBe(5298);
    expect(off.report.triangles).toBe(128);
    expect(run('bolt6', false).report.quads).toBe(5298);
  });

  it('floor on lifts the quad minSJ to >= 0.3, closed and manifold', () => {
    const on = run('bolt6', true);
    expect(on.quadMin).toBeGreaterThanOrEqual(0.3);
    expect(on.report.triangles).toBeGreaterThan(128);
    expect(on.report.openEdges).toBe(0);
    expect(on.report.nonManifoldEdges).toBe(0);
  });
});
