import { describe, expect, it } from 'vitest';
import { PATTERN_CASES } from '../../../examples/brep-pattern/render';
import { capFaces, kindsOf } from '../../../examples/quad-feature-baseline/kind-render';
import { quadrangulate } from '../quad';
import type { P2 } from '../vec';

// Real B-rep counterpart of trimface-row-orthogonal.unit.test.ts: the row quads of a planar trimmed cap
// are measured against the trim-loop tangent at their boundary vertices, not against synthetic rings.
const TOL = Math.sin((10 * Math.PI) / 180);

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function unit(d: P2): P2 {
  const l = Math.hypot(d[0], d[1]);
  return [d[0] / l, d[1] / l];
}

/** Share of row-quad radial sides within 10 degrees of perpendicular to the loop tangent at their vertex. */
function brepRowOrthogonality(id: string): { sides: number; share: number } {
  const make = PATTERN_CASES[id];
  if (make === undefined) throw new Error(`${id} missing`);
  const r = quadrangulate(make().shape, { size: 5, trimmed: 'blossom-row', source: 'boolean' });
  if (!r.ok) throw new Error(`${id} failed: ${r.error.code}`);
  const mesh = r.value.mesh;
  const kinds = kindsOf(r.value);
  const cap = capFaces(mesh, 'top');
  const uses = new Map<string, number>();
  const neighbours = new Map<number, number[]>();
  for (const f of cap) {
    const vs = mesh.faceVertices(f);
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i] as number;
      const b = vs[(i + 1) % vs.length] as number;
      uses.set(edgeKey(a, b), (uses.get(edgeKey(a, b)) ?? 0) + 1);
    }
  }
  for (const [key, n] of uses) {
    if (n !== 1) continue;
    const [a, b] = key.split(':').map(Number) as [number, number];
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  }
  const xy = (v: number): P2 => {
    const p = mesh.position(v);
    return [p[0], p[1]];
  };
  const tangentAt = (v: number): P2 | undefined => {
    const nb = neighbours.get(v) ?? [];
    if (nb.length !== 2) return undefined;
    const p = xy(nb[0] as number);
    const q = xy(nb[1] as number);
    return unit([q[0] - p[0], q[1] - p[1]]);
  };
  let good = 0;
  let sides = 0;
  for (const f of cap) {
    if (kinds[f] !== 'row') continue;
    const vs = mesh.faceVertices(f);
    const idx = vs.findIndex((v, i) => uses.get(edgeKey(v, vs[(i + 1) % 4] as number)) === 1);
    if (idx < 0) continue;
    const a = vs[idx] as number;
    const b = vs[(idx + 1) % 4] as number;
    const c = vs[(idx + 2) % 4] as number;
    const d = vs[(idx + 3) % 4] as number;
    for (const [v, inner] of [
      [a, d],
      [b, c],
    ] as const) {
      const t = tangentAt(v);
      if (t === undefined) continue;
      const pv = xy(v);
      const pi = xy(inner);
      const s = unit([pi[0] - pv[0], pi[1] - pv[1]]);
      sides++;
      if (Math.abs(t[0] * s[0] + t[1] * s[1]) <= TOL) good++;
    }
  }
  return { sides, share: sides === 0 ? 0 : good / sides };
}

describe('boundary-row orthogonality on real B-rep faces', () => {
  for (const id of ['bolt6', 'bolt12', 'paired']) {
    it(`${id}: row quads on the planar cap are orthogonal within 10 degrees`, () => {
      const m = brepRowOrthogonality(id);
      expect(m.sides).toBeGreaterThan(0);
      expect(m.share).toBeGreaterThanOrEqual(0.9);
    });
  }
});
