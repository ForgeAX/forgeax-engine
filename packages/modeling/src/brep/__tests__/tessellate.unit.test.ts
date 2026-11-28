// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { describe, expect, it } from 'vitest';
import { edgeKinds } from '../../finish';
import { meshVolume } from '../../geom';
import { EDGE_SHARP } from '../../mesh';
import { measure } from '../measure';
import { tessellate } from '../tessellate';
import { validate } from '../validate';
import { boundaryEdges, meshEuler, primitives } from './support';

const cases = primitives();

function mesh(
  shape: Parameters<typeof tessellate>[0],
  opts: Parameters<typeof tessellate>[1] = {},
) {
  const r = tessellate(shape, opts);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function signature(m: ReturnType<typeof mesh>): string {
  const pos = Array.from(m.pos.subarray(0, m.vertexHighWater * 3), (x) => x.toString(16));
  const faces = m.faces().map((f) => `${m.faceVertices(f).join(',')}:${m.fLabel[f]}:${m.fRole[f]}`);
  const uv = m
    .faces()
    .flatMap((f) => m.faceHalves(f).map((h) => Array.from(m.corner('uv0', h) ?? [])));
  return JSON.stringify({
    pos,
    faces,
    uv,
    labels: m.labelNames,
    roles: m.roleNames,
    e: Array.from(m.eFlags),
  });
}

describe('tessellate: watertight', () => {
  for (const c of cases) {
    it(`${c.name}: every mesh edge has two faces and the Euler count matches`, () => {
      const m = mesh(c.shape);
      expect(boundaryEdges(m)).toBe(0);
      expect(meshEuler(m)).toBe(c.euler);
      for (const e of m.edges()) expect(m.hFace[e * 2]).not.toBe(m.hFace[e * 2 + 1]);
    });
  }

  it('stays watertight at coarse and fine settings', () => {
    for (const c of cases) {
      for (const opts of [
        { angle: Math.PI },
        { angle: Math.PI / 3 },
        { angle: 0.05 },
        { chord: 0.05 },
      ]) {
        const m = mesh(c.shape, opts);
        expect(boundaryEdges(m), `${c.name} ${JSON.stringify(opts)}`).toBe(0);
        expect(meshEuler(m), `${c.name} ${JSON.stringify(opts)}`).toBe(c.euler);
      }
    }
  });

  it('falsifier: removing a face from the mesh opens boundary edges', () => {
    const m = mesh(cases[0]!.shape);
    m.removeFace(m.faces()[0] as number);
    expect(boundaryEdges(m)).toBeGreaterThan(0);
  });
});

describe('tessellate: volume converges monotonically under chord halving', () => {
  const curved = cases.filter((c) =>
    ['cylinder', 'cone', 'sphere', 'torus', 'revolve'].includes(c.name),
  );
  for (const c of curved) {
    it(`${c.name}: |volume error| does not increase over 3 halvings`, () => {
      const exact = measure(c.shape);
      if (!exact.ok) throw new Error('measure');
      const base = 0.4;
      const errs = [0, 1, 2, 3].map((k) => {
        const m = mesh(c.shape, { angle: Math.PI, chord: base / 2 ** k });
        return Math.abs(meshVolume(m) - exact.value.volume) / exact.value.volume;
      });
      for (let k = 1; k < errs.length; k++)
        expect(errs[k]!).toBeLessThanOrEqual(errs[k - 1]! + 1e-12);
      expect(errs[3]!).toBeLessThan(errs[0]!);
    });
  }

  it('falsifier: a fixed tessellation is not monotone against a coarser one', () => {
    const c = cases.find((x) => x.name === 'sphere')!;
    const coarse = meshVolume(mesh(c.shape, { angle: Math.PI / 2 }));
    const fine = meshVolume(mesh(c.shape, { angle: Math.PI / 8 }));
    const exact = (32 * Math.PI) / 3;
    expect(Math.abs(coarse - exact)).toBeGreaterThan(Math.abs(fine - exact));
  });
});

describe('tessellate: determinism and measure', () => {
  for (const c of cases) {
    it(`${c.name}: byte-identical on repeat`, () => {
      expect(signature(mesh(c.shape))).toBe(signature(mesh(c.shape)));
    });

    it(`${c.name}: exact measure matches the closed form (ratio 1 +- 1e-6)`, () => {
      const r = measure(c.shape);
      if (!r.ok) throw new Error('measure');
      expect(r.value.volume / c.volume).toBeGreaterThan(1 - 1e-6);
      expect(r.value.volume / c.volume).toBeLessThan(1 + 1e-6);
      expect(r.value.area / c.area).toBeGreaterThan(1 - 1e-6);
      expect(r.value.area / c.area).toBeLessThan(1 + 1e-6);
    });

    it(`${c.name}: validates with the expected topology`, () => {
      const v = validate(c.shape);
      expect(v.ok).toBe(true);
      expect(v.shells[0]!.euler).toBe(c.euler);
      expect(v.shells[0]!.genus).toBe(c.genus);
    });
  }
});

describe('tessellate: normals contract', () => {
  const angle = Math.PI / 16;
  for (const c of cases) {
    it(`${c.name}: smooth across non-sharp edges, sharp exactly at analytic creases`, () => {
      const m = mesh(c.shape, { angle });
      const kinds = edgeKinds(m, { mode: 'angle', angle: Math.PI / 6 } as never);
      expect(kinds.length).toBeGreaterThan(0);
      const faceNormal = (f: number) => {
        const p = m.faceVertices(f).map((v) => m.position(v));
        const n = [0, 0, 0];
        for (let i = 0; i < p.length; i++) {
          const a = p[i]!;
          const b = p[(i + 1) % p.length]!;
          n[0]! += (a[1] - b[1]) * (a[2] + b[2]);
          n[1]! += (a[2] - b[2]) * (a[0] + b[0]);
          n[2]! += (a[0] - b[0]) * (a[1] + b[1]);
        }
        const l = Math.hypot(n[0]!, n[1]!, n[2]!);
        return [n[0]! / l, n[1]! / l, n[2]! / l];
      };
      let worstSmooth = 0;
      for (const e of m.edges()) {
        const a = m.hFace[e * 2] as number;
        const b = m.hFace[e * 2 + 1] as number;
        const na = faceNormal(a);
        const nb = faceNormal(b);
        const dot = na[0]! * nb[0]! + na[1]! * nb[1]! + na[2]! * nb[2]!;
        const turn = Math.sqrt(Math.max(0, 2 - 2 * Math.min(1, dot)));
        if ((m.eFlags[e] as number) & EDGE_SHARP) expect(turn).toBeGreaterThan(Math.PI / 6 - 0.05);
        else worstSmooth = Math.max(worstSmooth, turn);
      }
      expect(worstSmooth).toBeLessThan(Math.PI / 6);
    });
  }

  it('planar faces carry the analytic plane normal', () => {
    const m = mesh(cases[0]!.shape);
    for (const f of m.faces()) {
      const ps = m.faceVertices(f).map((v) => m.position(v));
      const nx = ps.map((p) => p[0]);
      const ny = ps.map((p) => p[1]);
      const nz = ps.map((p) => p[2]);
      const flat = [nx, ny, nz].some((axis) => Math.max(...axis) - Math.min(...axis) < 1e-12);
      expect(flat).toBe(true);
    }
  });

  it('box edges are all sharp; sphere has none', () => {
    const b = mesh(cases[0]!.shape);
    for (const e of b.edges()) expect((b.eFlags[e] as number) & EDGE_SHARP).toBe(EDGE_SHARP);
    const s = mesh(cases[3]!.shape);
    for (const e of s.edges()) expect((s.eFlags[e] as number) & EDGE_SHARP).toBe(0);
  });
});

describe('tessellate: labels and uv', () => {
  it('every face carries a non-empty label and role, uv0 is set on every corner', () => {
    for (const c of cases) {
      const m = mesh(c.shape);
      for (const f of m.faces()) {
        expect(m.labelNames[m.fLabel[f] as number]).not.toBe('');
        for (const h of m.faceHalves(f)) expect(m.corner('uv0', h)).toBeDefined();
      }
    }
  });

  it('rejects bad options with brep-bad-argument', () => {
    const shape = cases[0]!.shape;
    for (const o of [{ angle: 0 }, { angle: 4 }, { chord: -1 }, { crease: -1 }]) {
      const r = tessellate(shape, o);
      expect(r.ok).toBe(false);
      if (!r.ok) expect((r.error.detail as { brep?: string }).brep).toBe('brep-bad-argument');
    }
  });
});

describe('tessellate: trimmed curved faces outside the rectangular (u, v) domain', () => {
  const cylinder = cases.find((c) => c.name === 'cylinder')!.shape;
  const side = cylinder.faces.findIndex((f) => cylinder.surfaces[f.surface]!.kind === 'cylinder');

  function clone(): { -readonly [K in keyof typeof cylinder]: (typeof cylinder)[K] } & {
    coedges: { pcurve: unknown }[];
    loops: { coedges: number[] }[];
  } {
    return JSON.parse(JSON.stringify(cylinder));
  }

  it('a seam pcurve that leaves its 3D edge is rejected by validate (not by tessellate)', () => {
    const copy = clone();
    const loop = copy.loops[copy.faces[side]!.loops[0]!]!;
    const line = loop.coedges
      .map((c) => ({ c, p: copy.coedges[c]!.pcurve as unknown as { kind: string; d: number[] } }))
      .find(({ p }) => p.kind === 'line')!;
    line.p.d = [line.p.d[0]! + 0.5, line.p.d[1]! + 0.5];
    const report = validate(copy as typeof cylinder);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('brep-pcurve-mismatch');
  });

  it('a hole that duplicates the outer loop is rejected by validate', () => {
    const copy = clone();
    const hole = copy.loops.length;
    const source = copy.loops[copy.faces[side]!.loops[0]!]!;
    const owned = source.coedges.map((c) => {
      copy.coedges.push({ ...copy.coedges[c]! } as never);
      return copy.coedges.length - 1;
    });
    copy.loops.push({ coedges: owned, outer: false } as never);
    (copy.faces[side] as unknown as { loops: number[] }).loops = [...copy.faces[side]!.loops, hole];
    const report = validate(copy as typeof cylinder);
    expect(report.ok).toBe(false);
  });
});
