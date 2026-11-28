// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { describe, expect, it } from 'vitest';
import { triangleArea } from '../../geom';
import type { EditMesh } from '../../mesh';
import { uvOverlapPairs } from '../../uv-overlap';
import { validateMesh } from '../../validate';
import { cone, revolve, sphere, torus } from '../build';
import { tessellate } from '../tessellate';
import type { Shape } from '../types';
import { primitives } from './support';

function mesh(shape: Shape, opts: Parameters<typeof tessellate>[1] = {}): EditMesh {
  const r = tessellate(shape, opts);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function turret(): Shape {
  const r = revolve({
    profile: [
      [0, 0],
      [2.2, 0],
      [2.2, 0.6],
      [1.6, 0.9],
      [1.2, 0.9],
      [1.2, 1.8],
      [0.6, 2.2],
      [0, 2.2],
    ],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function must(r: ReturnType<typeof sphere>): Shape {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function uvArea(m: EditMesh, f: number): number {
  const uv = m.faceHalves(f).map((h) => Array.from(m.corner('uv0', h) as Float32Array));
  let a = 0;
  for (let i = 1; i + 1 < uv.length; i++) {
    a += Math.abs(
      triangleArea(
        [uv[0]![0]!, uv[0]![1]!, 0],
        [uv[i]![0]!, uv[i]![1]!, 0],
        [uv[i + 1]![0]!, uv[i + 1]![1]!, 0],
      ),
    );
  }
  return a;
}

function worldArea(m: EditMesh, f: number): number {
  const p = m.faceVertices(f).map((v) => m.position(v) as unknown as [number, number, number]);
  let a = 0;
  for (let i = 1; i + 1 < p.length; i++) a += triangleArea(p[0]!, p[i]!, p[i + 1]!);
  return a;
}

describe('metric uv0', () => {
  it('turret-class shape: S1 validate is clean and no uv0 triangles overlap', () => {
    const m = mesh(turret());
    const report = validateMesh(m, 1e-6, { surface: { need: ['uv0'] } });
    expect(report.issues.filter((i) => i.code === 'surface')).toEqual([]);
    expect(uvOverlapPairs(m, m.faces(), 'uv0')).toEqual([]);
  });

  it('every primitive: one cell, no overlap, finite', () => {
    for (const c of primitives()) {
      const m = mesh(c.shape);
      const report = validateMesh(m, 1e-6, { surface: { need: ['uv0'] } });
      expect(
        report.issues.filter((i) => i.code === 'surface'),
        c.name,
      ).toEqual([]);
      expect(uvOverlapPairs(m, m.faces(), 'uv0'), c.name).toEqual([]);
    }
  });

  it('layout does not depend on angle or chord (G-4): face uv bounding boxes agree', () => {
    const shape = turret();
    const box = (m: EditMesh) => {
      const by = new Map<string, number[]>();
      for (const f of m.faces()) {
        const key = m.labelNames[m.fLabel[f] as number] as string;
        const b = by.get(key) ?? [Infinity, Infinity, -Infinity, -Infinity];
        for (const h of m.faceHalves(f)) {
          const c = m.corner('uv0', h) as Float32Array;
          b[0] = Math.min(b[0]!, c[0]!);
          b[1] = Math.min(b[1]!, c[1]!);
          b[2] = Math.max(b[2]!, c[0]!);
          b[3] = Math.max(b[3]!, c[1]!);
        }
        by.set(key, b);
      }
      return by;
    };
    const coarse = box(mesh(shape, { angle: Math.PI / 4 }));
    const fine = box(mesh(shape, { angle: 0.05, chord: 0.01 }));
    expect([...fine.keys()].sort()).toEqual([...coarse.keys()].sort());
    for (const [k, b] of coarse) {
      for (let i = 0; i < 4; i++) expect((fine.get(k) as number[])[i]!, k).toBeCloseTo(b[i]!, 4);
    }
  });

  it('developable turret faces: uv area over world area is near-constant per mesh', () => {
    const shape = turret();
    const m = mesh(shape, { angle: Math.PI / 32 });
    const ratios = m.faces().map((f) => uvArea(m, f) / worldArea(m, f));
    expect(Math.max(...ratios) / Math.min(...ratios)).toBeLessThan(1.05);
  });

  it('curved faces are not uniform: per-face quad uv/world area spread is pinned (X1a-followup)', () => {
    const spread = (shape: Shape) => {
      const m = mesh(shape);
      const ratios = m.faces().map((f) => uvArea(m, f) / worldArea(m, f));
      return Math.max(...ratios) / Math.min(...ratios);
    };
    const pinned = { sphere: 5.1, cone: 1.99, torus: 1.99, fatTorus: 8.63 };
    const got = {
      sphere: spread(must(sphere({ radius: 2 }))),
      cone: spread(must(cone({ radius: 2, height: 3 }))),
      torus: spread(must(torus({ major: 3, minor: 1 }))),
      fatTorus: spread(must(torus({ major: 1, minor: 0.8 }))),
    };
    for (const k of Object.keys(pinned) as (keyof typeof pinned)[])
      expect(got[k], k).toBeCloseTo(pinned[k], 1);
  });

  it('plane and cylinder faces are exactly metric: uv area over world area is constant to 1e-3', () => {
    for (const name of ['box', 'cylinder', 'extrude-holed']) {
      const c = primitives().find((p) => p.name === name)!;
      const m = mesh(c.shape, { angle: Math.PI / 32 });
      const ratios = m.faces().map((f) => uvArea(m, f) / worldArea(m, f));
      expect(Math.max(...ratios) / Math.min(...ratios), name).toBeLessThan(1.001);
    }
  });

  it('sphere and torus charts keep the metric aspect of their parameter box', () => {
    const extent = (shape: Shape) => {
      const m = mesh(shape);
      const lo = [Infinity, Infinity];
      const hi = [-Infinity, -Infinity];
      for (const f of m.faces())
        for (const h of m.faceHalves(f)) {
          const c = m.corner('uv0', h) as Float32Array;
          for (const k of [0, 1]) {
            lo[k] = Math.min(lo[k]!, c[k]!);
            hi[k] = Math.max(hi[k]!, c[k]!);
          }
        }
      return (hi[0]! - lo[0]!) / (hi[1]! - lo[1]!);
    };
    const s = sphere({ radius: 2 });
    const t = torus({ major: 3, minor: 0.5 });
    if (!s.ok || !t.ok) throw new Error('build');
    expect(extent(s.value)).toBeCloseTo(2 * (2 / Math.PI), 2);
    expect(extent(t.value)).toBeCloseTo(3 / 0.5, 2);
  });

  it('packing fills the cell: charts cover a fifth or more of the unit square', () => {
    for (const name of ['box', 'extrude-holed']) {
      const c = primitives().find((p) => p.name === name)!;
      const m = mesh(c.shape);
      const covered = m.faces().reduce((a, f) => a + uvArea(m, f), 0);
      expect(covered, name).toBeGreaterThan(0.2);
    }
    const m = mesh(turret());
    expect(m.faces().reduce((a, f) => a + uvArea(m, f), 0)).toBeGreaterThan(0.2);
  });

  it('zones: a role maps its faces into its cell and the shared period keeps them inside', () => {
    const shape = turret();
    const labels = shape.faces.map((f) => f.label);
    const zoned: Shape = {
      ...shape,
      faces: shape.faces.map((f, i) => ({ ...f, role: i % 2 === 0 ? 'hull' : 'dome' })),
    };
    expect(labels.length).toBeGreaterThan(2);
    const m = mesh(zoned, { uv: { zones: { hull: [0, 0], dome: [2, 1] } } });
    for (const f of m.faces()) {
      const role = m.roleNames[m.fRole[f] as number];
      const cell = role === 'dome' ? [2, 1] : [0, 0];
      for (const h of m.faceHalves(f)) {
        const c = m.corner('uv0', h) as Float32Array;
        expect(c[0]!).toBeGreaterThanOrEqual(cell[0]! - 1e-6);
        expect(c[0]!).toBeLessThanOrEqual(cell[0]! + 1 + 1e-6);
        expect(c[1]!).toBeGreaterThanOrEqual(cell[1]! - 1e-6);
        expect(c[1]!).toBeLessThanOrEqual(cell[1]! + 1 + 1e-6);
      }
    }
    expect(uvOverlapPairs(m, m.faces(), 'uv0')).toEqual([]);
  });

  it('bad uv options are brep-bad-argument', () => {
    const shape = turret();
    for (const uv of [
      { gutter: 0 },
      { gutter: Number.NaN },
      { zones: { a: [0.5, 0] as [number, number] } },
      { zones: { a: [0] as unknown as [number, number] } },
    ]) {
      const r = tessellate(shape, { uv });
      expect(r.ok).toBe(false);
      if (!r.ok) expect((r.error.detail as { brep?: string }).brep).toBe('brep-bad-argument');
    }
  });

  it('a role named like an Object.prototype member resolves to the default cell, never NaN', () => {
    const shape = turret();
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const zoned: Shape = { ...shape, faces: shape.faces.map((f) => ({ ...f, role: name })) };
      const m = mesh(zoned, { uv: { zones: { other: [3, 3] } } });
      for (const f of m.faces())
        for (const h of m.faceHalves(f)) {
          const c = m.corner('uv0', h) as Float32Array;
          expect(Number.isFinite(c[0]!) && Number.isFinite(c[1]!), name).toBe(true);
          expect(c[0]!, name).toBeLessThanOrEqual(1 + 1e-6);
        }
    }
  });

  it('a zone declared for a prototype-named role is honoured', () => {
    const shape = turret();
    const zoned: Shape = {
      ...shape,
      faces: shape.faces.map((f) => ({ ...f, role: 'constructor' })),
    };
    const m = mesh(zoned, { uv: { zones: JSON.parse('{"constructor":[2,1]}') } });
    for (const f of m.faces())
      for (const h of m.faceHalves(f)) {
        const c = m.corner('uv0', h) as Float32Array;
        expect(c[0]!).toBeGreaterThanOrEqual(2 - 1e-6);
        expect(c[1]!).toBeGreaterThanOrEqual(1 - 1e-6);
      }
  });

  it('malformed cells are rejected: holes, wrong length, and a bad entry after a good one', () => {
    const shape = turret();
    const hole: unknown[] = [];
    hole[1] = 1;
    const holeLast: unknown[] = [1];
    holeLast.length = 2;
    const bad: unknown[] = [
      { zones: { a: hole } },
      { zones: { a: holeLast } },
      { zones: { a: [0, 1, 2] } },
      { zones: { a: [] } },
      { zones: { ok: [0, 0], a: [0.5, 0] } },
      { zones: { ok: [0, 0], also: [1, 1], a: hole } },
      { zones: { ok: [0, 0], a: [0, 1, 2] } },
      { zones: { a: ['1', 0] } },
      { zones: { a: [Number.NaN, 0] } },
    ];
    for (const uv of bad) {
      const r = tessellate(shape, { uv } as never);
      expect(r.ok, JSON.stringify(uv)).toBe(false);
      if (!r.ok) expect((r.error.detail as { brep?: string }).brep).toBe('brep-bad-argument');
    }
  });

  it('uv, zones and cell magnitude are validated as Results, never thrown', () => {
    const shape = turret();
    const bad: unknown[] = [
      null,
      7,
      [],
      { zones: null },
      { zones: [] },
      { zones: { a: [1025, 0] } },
      { zones: { a: [0, -1025] } },
    ];
    for (const uv of bad) {
      const r = tessellate(shape, { uv } as never);
      expect(r.ok, JSON.stringify(uv)).toBe(false);
      if (!r.ok) expect((r.error.detail as { brep?: string }).brep).toBe('brep-bad-argument');
    }
    expect(tessellate(shape, { uv: { zones: { a: [1024, -1024] } } }).ok).toBe(true);
  });

  describe('uv is read once into a validated snapshot', () => {
    const shape = turret();
    const zoned: Shape = { ...shape, faces: shape.faces.map((f) => ({ ...f, role: 'part' })) };
    const finiteUv = (m: EditMesh): boolean => {
      for (const f of m.faces())
        for (const h of m.faceHalves(f)) {
          const c = m.corner('uv0', h) as Float32Array;
          if (!Number.isFinite(c[0]!) || !Number.isFinite(c[1]!)) return false;
        }
      return true;
    };
    const brepOf = (r: ReturnType<typeof tessellate>): string | undefined =>
      r.ok ? undefined : (r.error.detail as { brep?: string }).brep;

    it('a non-enumerable own zone is outside the snapshot: default cell, finite uv0', () => {
      const zones: Record<string, unknown> = {};
      Object.defineProperty(zones, 'part', { value: [Number.NaN, 1], enumerable: false });
      const r = tessellate(zoned, { uv: { zones } as never });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(finiteUv(r.value)).toBe(true);
        const plain = mesh(zoned);
        for (const f of r.value.faces())
          for (const h of r.value.faceHalves(f))
            expect(r.value.corner('uv0', h)).toEqual(plain.corner('uv0', h));
      }
    });

    it('a getter that changes value after validation cannot reach the layout', () => {
      let reads = 0;
      const zones = {
        get part() {
          reads++;
          return reads === 1 ? [2, 1] : [Number.NaN, 0];
        },
      };
      const r = tessellate(zoned, { uv: { zones } as never });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(finiteUv(r.value)).toBe(true);
        const fixed = mesh(zoned, { uv: { zones: { part: [2, 1] } } });
        for (const f of r.value.faces())
          for (const h of r.value.faceHalves(f))
            expect(r.value.corner('uv0', h)).toEqual(fixed.corner('uv0', h));
      }
      expect(reads).toBe(1);
    });

    it('a cell element getter is read once and gutter is read once', () => {
      let reads = 0;
      const cell = [0, 0];
      Object.defineProperty(cell, 0, {
        get: () => (++reads === 1 ? 1 : Number.NaN),
        enumerable: true,
      });
      let gutterReads = 0;
      const uv = {
        zones: { part: cell },
        get gutter() {
          return ++gutterReads === 1 ? 0.01 : Number.NaN;
        },
      };
      const r = tessellate(zoned, { uv: uv as never });
      expect(r.ok).toBe(true);
      if (r.ok) expect(finiteUv(r.value)).toBe(true);
      expect(reads).toBe(1);
      expect(gutterReads).toBe(1);
    });

    it('a throwing getter becomes brep-bad-argument, never a throw', () => {
      const boom = (): never => {
        throw new Error('boom');
      };
      const cases: unknown[] = [
        {
          get zones() {
            return boom();
          },
        },
        {
          get gutter() {
            return boom();
          },
        },
        {
          zones: {
            get part() {
              return boom();
            },
          },
        },
        { zones: { part: Object.defineProperty([0, 0], 0, { get: boom }) } },
      ];
      for (const uv of cases) {
        let r: ReturnType<typeof tessellate> | undefined;
        expect(() => {
          r = tessellate(zoned, { uv } as never);
        }).not.toThrow();
        expect(r?.ok).toBe(false);
        expect(r && brepOf(r)).toBe('brep-bad-argument');
      }
      expect(() =>
        tessellate(zoned, { uv: new Proxy({}, { ownKeys: boom, get: boom }) } as never),
      ).not.toThrow();
    });

    it('options.uv is read once: a second read never reaches the layout', () => {
      let reads = 0;
      const options = {
        get uv() {
          return ++reads === 1 ? { zones: { part: [2, 1] } } : { zones: { part: [Number.NaN, 0] } };
        },
      };
      const r = tessellate(zoned, options as never);
      expect(reads).toBe(1);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const fixed = mesh(zoned, { uv: { zones: { part: [2, 1] } } });
        for (const f of r.value.faces())
          for (const h of r.value.faceHalves(f))
            expect(r.value.corner('uv0', h)).toEqual(fixed.corner('uv0', h));
      }
    });

    it('a thrown value that cannot be stringified still ends as brep-bad-argument', () => {
      const hostile: unknown[] = [
        {
          toString() {
            throw new Error('no string');
          },
        },
        Object.create(null),
        Object.create(null, {
          message: {
            get() {
              throw new Error('no message');
            },
          },
        }),
      ];
      for (const thrown of hostile) {
        const uv = {
          get zones(): never {
            throw thrown;
          },
        };
        let r: ReturnType<typeof tessellate> | undefined;
        expect(() => {
          r = tessellate(zoned, { uv } as never);
        }).not.toThrow();
        expect(r && brepOf(r)).toBe('brep-bad-argument');
      }
    });

    it('an enumerable inherited zone is outside the snapshot', () => {
      const zones = Object.create({ part: [2, 1] }) as Record<string, unknown>;
      const r = tessellate(zoned, { uv: { zones } as never });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const plain = mesh(zoned);
        for (const f of r.value.faces())
          for (const h of r.value.faceHalves(f))
            expect(r.value.corner('uv0', h)).toEqual(plain.corner('uv0', h));
      }
    });

    it('an array-like cell, a fractional second axis and an infinite gutter are rejected', () => {
      const bad: unknown[] = [
        { zones: { part: { 0: 0, 1: 0, length: 2 } } },
        { zones: { part: [0, 0.5] } },
        { zones: { part: [0, Number.POSITIVE_INFINITY] } },
        { gutter: Number.POSITIVE_INFINITY },
        { gutter: Number.NEGATIVE_INFINITY },
      ];
      for (const uv of bad) {
        const r = tessellate(zoned, { uv } as never);
        expect(r.ok, JSON.stringify(uv)).toBe(false);
        expect(brepOf(r), JSON.stringify(uv)).toBe('brep-bad-argument');
      }
    });

    it('a huge finite gutter is a brep Result error or a finite uv0, and 1e308 is brep-bad-argument', () => {
      const shapes = [
        turret(),
        ...['box', 'cylinder'].map((n) => primitives().find((p) => p.name === n)!.shape),
      ];
      let rejected = 0;
      for (const shape of shapes)
        for (const gutter of [1e10, 1e100, 1e300, 5e307, 8e307, 1e308, Number.MAX_VALUE]) {
          const r = tessellate(shape, { uv: { gutter } });
          if (r.ok) expect(finiteUv(r.value), `${gutter}`).toBe(true);
          else {
            rejected++;
            expect(brepOf(r), `${gutter}`).toBeDefined();
          }
        }
      expect(rejected).toBeGreaterThan(0);
      for (const shape of shapes) {
        const r = tessellate(shape, { uv: { gutter: 1e308 } });
        expect(r.ok).toBe(false);
        expect(brepOf(r)).toBe('brep-bad-argument');
      }
    });

    it('options angle, chord, crease and uv are read once; hostile options are brep-bad-argument', () => {
      const reads: Record<string, number> = { angle: 0, chord: 0, crease: 0, uv: 0 };
      const options = {
        get angle() {
          return ++reads.angle! === 1 ? 0.2 : Number.NaN;
        },
        get chord() {
          return ++reads.chord! === 1 ? undefined : Number.NaN;
        },
        get crease() {
          return ++reads.crease! === 1 ? 0.5 : Number.NaN;
        },
        get uv() {
          return ++reads.uv! === 1 ? undefined : { gutter: Number.NaN };
        },
      };
      expect(tessellate(zoned, options as never).ok).toBe(true);
      expect(reads).toEqual({ angle: 1, chord: 1, crease: 1, uv: 1 });
      const boom = (): never => {
        throw new Error('boom');
      };
      const hostile: unknown[] = [
        null,
        {
          get angle() {
            return boom();
          },
        },
        {
          get chord() {
            return boom();
          },
        },
        {
          get crease() {
            return boom();
          },
        },
        new Proxy({}, { get: boom }),
      ];
      for (const o of hostile) {
        let r: ReturnType<typeof tessellate> | undefined;
        expect(() => {
          r = tessellate(zoned, o as never);
        }).not.toThrow();
        expect(r && brepOf(r), `${hostile.indexOf(o)}`).toBe('brep-bad-argument');
      }
    });

    it('a finite gutter that collapses the charts below float32 resolution is rejected', () => {
      const shapes = [
        zoned,
        ...['box', 'cylinder', 'extrude-holed'].map(
          (n) => primitives().find((p) => p.name === n)!.shape,
        ),
      ];
      for (const shape of shapes) {
        for (const gutter of [1e8, 1e9, 1e10, 1e100]) {
          expect(brepOf(tessellate(shape, { uv: { gutter } })), `${gutter}`).toBe(
            'brep-bad-argument',
          );
        }
        for (const gutter of [1e-3, 1, 1e3]) {
          const r = tessellate(shape, { uv: { gutter } });
          expect(r.ok, `${gutter}`).toBe(true);
          if (r.ok) {
            expect(finiteUv(r.value)).toBe(true);
            const flat = r.value.faces().filter((f) => !(uvArea(r.value, f) > 0));
            expect(flat, `${gutter}`).toEqual([]);
          }
        }
      }
    });

    it('a Proxy that answers differently on later reads cannot reach the layout', () => {
      let gets = 0;
      const zones = new Proxy(
        { part: [3, 3] },
        {
          get(target, key) {
            gets++;
            return gets === 1 ? Reflect.get(target, key) : [Number.NaN, Number.NaN];
          },
          ownKeys: (target) => Reflect.ownKeys(target),
          getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, key),
          has: () => true,
        },
      );
      const r = tessellate(zoned, { uv: { zones } as never });
      expect(r.ok).toBe(true);
      if (r.ok) expect(finiteUv(r.value)).toBe(true);
    });

    it('a Proxy that hides a key from ownKeys leaves it out of the layout', () => {
      const zones = new Proxy(
        { part: [Number.NaN, 0] },
        { ownKeys: () => [], getOwnPropertyDescriptor: () => undefined },
      );
      const r = tessellate(zoned, { uv: { zones } as never });
      expect(r.ok).toBe(true);
      if (r.ok) expect(finiteUv(r.value)).toBe(true);
    });
  });
});
