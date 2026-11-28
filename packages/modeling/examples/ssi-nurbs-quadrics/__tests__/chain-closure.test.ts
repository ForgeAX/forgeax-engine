// Chain-level closure of the manifold NURBS cuts. The boolean-facing unit is the chain: branches
// joined by endpoint pairing (joinBranches, eps 1e-6). These pins record the measured closure and the
// measured transition-torus open ends. A change to the marcher or to the model seams must move them.
import { expect, it } from 'vitest';
import { curvePoint as cp } from '../../../src/brep/curves.ts';
import { type IntersectionBranch, intersectSurfaces } from '../../../src/brep/intersect.ts';
import { joinBranches } from '../../../src/brep/query/stitch.ts';
import { makeFrame, surfacePoint } from '../../../src/brep/surfaces.ts';
import type { Surface } from '../../../src/brep/types.ts';
import { surfaceDomain } from '../../../src/nurbs.ts';
import { buildManifold, MANIFOLD } from '../../manifold/showcase.ts';

const TOL = 1e-7;
const JOIN_EPS = 1e-6;

function nurbsFaces(name: string): any[] {
  const m = buildManifold();
  const part = m.parts[m.names.indexOf(name)] as any;
  return part.faces
    .map((f: any) => part.surfaces[f.surface])
    .filter((s: any) => s !== undefined && s.kind === 'nurbs');
}

function partCentre(faces: any[]): [number, number, number] {
  const s: [number, number, number] = [0, 0, 0];
  let n = 0;
  for (const f of faces) {
    const [[u0, u1], [v0, v1]] = surfaceDomain(f.surface) as any;
    for (let i = 0; i <= 8; i++)
      for (let j = 0; j <= 8; j++) {
        const p = surfacePoint(f, u0 + ((u1 - u0) * i) / 8, v0 + ((v1 - v0) * j) / 8);
        s[0] += p[0];
        s[1] += p[1];
        s[2] += p[2];
        n++;
      }
  }
  return s.map((x) => x / n) as [number, number, number];
}

function cutter(kind: 'sphere' | 'cone' | 'torus', c: [number, number, number]): Surface {
  const frame = makeFrame(c, [0, 0, 1]);
  if (kind === 'sphere') return { kind, frame, radius: MANIFOLD.pipe * 1.6 } as Surface;
  if (kind === 'cone')
    return { kind, frame, radius: MANIFOLD.bore * 0.6, halfAngle: 0.35 } as Surface;
  return { kind, frame, major: MANIFOLD.pipe * 2.2, minor: MANIFOLD.pipe * 0.35 } as Surface;
}

function cut(name: string, kind: 'sphere' | 'cone' | 'torus') {
  const faces = nurbsFaces(name);
  const surf = cutter(kind, partCentre(faces));
  const branches: IntersectionBranch[] = [];
  for (const f of faces) {
    const r = intersectSurfaces(f, surf, TOL);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    branches.push(...r.value.branches);
  }
  const chains = joinBranches(
    branches.map((b) => ({
      closed: b.closed,
      ends: [[...cp(b.curve, b.t0)], [...cp(b.curve, b.t1)]] as any,
    })),
    JOIN_EPS,
  );
  const reasons: Record<string, number> = {};
  for (const ch of chains)
    for (const e of ch.ends) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
  return {
    branches: branches.length,
    closedBranches: branches.filter((b) => b.closed).length,
    chains: chains.length,
    closedChains: chains.filter((ch: any) => ch.closed === true).length,
    reasons,
  };
}

it('s-bend sphere and cone close into 4 chains each', { timeout: 240000 }, () => {
  for (const kind of ['sphere', 'cone'] as const) {
    const c = cut('s-bend', kind);
    expect(c.chains).toBe(4);
    expect(c.closedChains).toBe(4);
    expect(c.reasons).toEqual({});
  }
});

it('s-bend torus: 3 closed chains and 6 junction ends', { timeout: 240000 }, () => {
  const c = cut('s-bend', 'torus');
  expect(c.chains).toBe(6);
  expect(c.closedChains).toBe(3);
  expect(c.reasons).toEqual({ junction: 6 });
});

it('transition sphere and cone close into 4 chains each', { timeout: 240000 }, () => {
  for (const kind of ['sphere', 'cone'] as const) {
    const c = cut('transition', kind);
    expect(c.chains).toBe(4);
    expect(c.closedChains).toBe(4);
  }
});

it('transition torus: 8 open chains and 16 gap-over-tol ends', { timeout: 240000 }, () => {
  const c = cut('transition', 'torus');
  expect(c.chains).toBe(8);
  expect(c.closedChains).toBe(0);
  expect(c.reasons).toEqual({ 'gap-over-tol': 16 });
});
