import { describe, expect, it } from 'vitest';
import { cross, length, sub, type Tuple3 } from '../geom';
import { model } from '../model';
import type { NurbsSurface } from '../nurbs';

function rect(x0: number, w: number, h: number): NurbsSurface {
  return {
    degreeU: 1,
    degreeV: 1,
    points: [
      [
        [x0, 0, 0],
        [x0, 0, h],
      ],
      [
        [x0 + w, 0, 0],
        [x0 + w, 0, h],
      ],
    ] as Tuple3[][],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

function strips() {
  const m = model();
  m.surface({
    patches: [
      { surface: rect(0, 1, 1), name: 'small' },
      { surface: rect(5, 8, 1), name: 'long' },
    ],
    chord: 0.01,
  });
  return m;
}

const corners = (m: ReturnType<typeof strips>, channel: 'uv0' | 'uv1') =>
  m.editMesh
    .faces()
    .flatMap((f) =>
      m.editMesh
        .faceHalves(f)
        .map((h) => Array.from(m.editMesh.corner(channel, h) as Float32Array)),
    );

function density(m: ReturnType<typeof strips>, role: string): number {
  const mesh = m.editMesh;
  const faces = mesh.faces().filter((f) => mesh.hasTag(f, mesh.tagIndex(role, false)));
  let uv = 0;
  let area = 0;
  for (const f of faces) {
    const hs = mesh.faceHalves(f);
    const p = hs.map((h) => mesh.position(mesh.hVert[h] as number) as Tuple3);
    const q = hs.map((h) => Array.from(mesh.corner('uv0', h) as Float32Array) as [number, number]);
    for (let k = 1; k + 1 < hs.length; k++) {
      const [a, b, c] = [q[0], q[k], q[k + 1]] as [
        [number, number],
        [number, number],
        [number, number],
      ];
      uv += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      area +=
        length(
          cross(sub(p[k] as Tuple3, p[0] as Tuple3), sub(p[k + 1] as Tuple3, p[0] as Tuple3)),
        ) / 2;
    }
  }
  return Math.sqrt(uv / area);
}

const QUARTER_WEIGHT = Math.SQRT1_2;

function quarterCylinder(cx: number, radius: number, height: number): NurbsSurface {
  const ring = (y: number): Tuple3[] => [
    [cx + radius, y, 0],
    [cx + radius, y, radius],
    [cx, y, radius],
  ];
  const lo = ring(0);
  const hi = ring(height);
  return {
    degreeU: 2,
    degreeV: 1,
    points: [0, 1, 2].map((i) => [lo[i], hi[i]] as Tuple3[]),
    weights: [
      [1, 1],
      [QUARTER_WEIGHT, QUARTER_WEIGHT],
      [1, 1],
    ],
    knotsU: [0, 0, 0, 1, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

function cylinders() {
  const m = model();
  m.surface({
    patches: [
      { surface: quarterCylinder(0, 0.5, 1), name: 'pipe' },
      { surface: quarterCylinder(10, 4, 2), name: 'drum' },
    ],
    chord: 0.005,
  });
  return m;
}

function uvSpan(m: ReturnType<typeof strips>, role: string): [number, number] {
  const mesh = m.editMesh;
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  for (const f of mesh.faces().filter((g) => mesh.hasTag(g, mesh.tagIndex(role, false)))) {
    for (const h of mesh.faceHalves(f)) {
      const c = mesh.corner('uv0', h) as Float32Array;
      for (const k of [0, 1]) {
        lo[k] = Math.min(lo[k] as number, c[k] as number);
        hi[k] = Math.max(hi[k] as number, c[k] as number);
      }
    }
  }
  return [(hi[0] as number) - (lo[0] as number), (hi[1] as number) - (lo[1] as number)];
}

describe('uv.fromPatch: BK51', () => {
  it('intrinsic leaves each patch its own unit cell and uv1 untouched', () => {
    const m = strips();
    const before = corners(m, 'uv1');
    const r = m.uv.fromPatch({ mode: 'intrinsic', zone: [2, 3] });
    expect(r.status).toBe('ok');
    expect(corners(m, 'uv1')).toEqual(before);
    for (const c of corners(m, 'uv0')) {
      expect(c[0] as number).toBeGreaterThanOrEqual(2);
      expect(c[0] as number).toBeLessThanOrEqual(3);
      expect(c[1] as number).toBeGreaterThanOrEqual(3);
      expect(c[1] as number).toBeLessThanOrEqual(4);
    }
    const info = r.diagnostics?.find((d) => d.message.startsWith('uv.fromPatch'))?.detail as {
      groups: number;
      densitySpread: number;
    };
    expect(info.groups).toBe(2);
    expect(info.densitySpread).toBeGreaterThan(2.5);
  });

  it('conformalScaled gives both patches one texel density and keeps every patch in its cell', () => {
    const m = strips();
    const r = m.uv.fromPatch({ mode: 'conformalScaled', zone: [1, 0] });
    expect(r.status).toBe('ok');
    const info = r.diagnostics?.find((d) => d.message.startsWith('uv.fromPatch'))?.detail as {
      densitySpread: number;
      period: number;
    };
    expect(info.densitySpread).toBeCloseTo(1, 4);
    expect(info.period).toBeCloseTo(8, 3);
    expect(density(m, 'small')).toBeCloseTo(density(m, 'long'), 4);
    expect(density(m, 'long')).toBeCloseTo(1 / 8, 4);
    expect(
      m
        .validate({ surface: { zones: { small: [1, 0], long: [1, 0] }, need: ['uv0', 'uv1'] } })
        .issues.filter((i) => i.code === 'surface'),
    ).toEqual([]);
  });

  it('curved patches: the rescale follows the arc length, not the chord of the patch corners', () => {
    const m = cylinders();
    const r = m.uv.fromPatch({ mode: 'conformalScaled' });
    expect(r.status).toBe('ok');
    const info = r.diagnostics?.find((d) => d.message.startsWith('uv.fromPatch'))?.detail as {
      densitySpread: number;
      period: number;
    };
    expect(info.densitySpread).toBeCloseTo(1, 2);
    const arc = (radius: number) => (radius * Math.PI) / 2;
    expect(info.period).toBeCloseTo(arc(4), 1);
    for (const [name, radius, height] of [
      ['pipe', 0.5, 1],
      ['drum', 4, 2],
    ] as const) {
      const [du, dv] = uvSpan(m, name);
      expect(du * info.period).toBeCloseTo(arc(radius), 1);
      expect(Math.abs(du * info.period - Math.SQRT2 * radius)).toBeGreaterThan(0.1 * radius);
      expect(dv * info.period).toBeCloseTo(height, 1);
    }
    expect(density(m, 'pipe')).toBeCloseTo(density(m, 'drum'), 2);
  });

  it('curved patches: intrinsic keeps the normalized domain, so the same two cylinders differ in density', () => {
    const m = cylinders();
    const r = m.uv.fromPatch({ mode: 'intrinsic' });
    const info = r.diagnostics?.find((d) => d.message.startsWith('uv.fromPatch'))?.detail as {
      densitySpread: number;
    };
    expect(info.densitySpread).toBeGreaterThan(4);
  });

  it('a period smaller than the patch extent is reported by the surface contract as a straddle', () => {
    const m = strips();
    m.uv.fromPatch({ mode: 'conformalScaled', period: 4 });
    const issues = m
      .validate({ surface: { need: ['uv0'] } })
      .issues.filter((i) => i.code === 'surface');
    expect(issues.map((i) => i.detail.check)).toContain('zone-straddle');
  });

  it('surface-mode normals are identical before and after', () => {
    const m = strips();
    const read = () => {
      const out = m.toMesh({ normals: { mode: 'surface' } as never });
      if (!out.ok) throw new Error('export');
      return Array.from(out.value.mesh.attributes.normal as Float32Array);
    };
    const before = read();
    m.uv.fromPatch({ mode: 'conformalScaled' });
    expect(read()).toEqual(before);
  });

  it('a mesh without the patch domain is a precondition error', () => {
    const m = model();
    m.plane({ width: 1, height: 1 });
    const r = m.uv.fromPatch({ mode: 'intrinsic' });
    expect(r.status).not.toBe('ok');
    expect(JSON.stringify(r.error)).toContain('no-patch-domain');
  });

  it('rejects an unknown mode, a fractional zone and a bad period', () => {
    const m = strips();
    for (const options of [
      { mode: 'bogus' },
      { mode: 'intrinsic', zone: [0.5, 0] },
      { mode: 'conformalScaled', period: 0 },
      { mode: 'intrinsic', period: 2 },
    ]) {
      const r = m.uv.fromPatch(options as never);
      expect(r.status).not.toBe('ok');
    }
  });
});

describe('uv.fromPatch: audit follow-up', () => {
  const info = (r: ReturnType<ReturnType<typeof strips>['uv']['fromPatch']>) =>
    r.diagnostics?.find((d) => d.detail?.mode !== undefined)?.detail as
      | { groups: number; skipped: number; densitySpread: number; period: number }
      | undefined;
  const facesOf = (m: ReturnType<typeof strips>, role: string) => {
    const mesh = m.editMesh;
    return mesh.faces().filter((f) => mesh.hasTag(f, mesh.tagIndex(role, false)));
  };
  const mapUv1 = (
    m: ReturnType<typeof strips>,
    role: string,
    fn: (c: Float32Array) => [number, number],
  ) => {
    for (const f of facesOf(m, role))
      for (const h of m.editMesh.faceHalves(f)) {
        const c = m.editMesh.corner('uv1', h) as Float32Array;
        m.editMesh.setCorner('uv1', h, fn(c));
      }
  };
  const uv0Of = (m: ReturnType<typeof strips>) => corners(m, 'uv0');

  it('intrinsic spread is the ratio of root texel densities (1 / sqrt(1/8))', () => {
    const r = strips().uv.fromPatch({ mode: 'intrinsic' });
    expect(info(r)?.densitySpread).toBeCloseTo(Math.sqrt(8), 3);
  });

  it('a domain that does not start at the cell origin lands where the origin-based one does', () => {
    const plain = strips();
    plain.uv.fromPatch({ mode: 'conformalScaled' });
    const shifted = strips();
    mapUv1(shifted, 'long', (c) => [(c[0] as number) + 0.25, (c[1] as number) + 0.5]);
    shifted.uv.fromPatch({ mode: 'conformalScaled' });
    const a = uv0Of(plain);
    const b = uv0Of(shifted);
    expect(b.length).toBe(a.length);
    a.forEach((c, i) => {
      expect(b[i]?.[0]).toBeCloseTo(c[0] as number, 5);
      expect(b[i]?.[1]).toBeCloseTo(c[1] as number, 5);
    });
  });

  it('adjacent patches with different domains stay separate groups', () => {
    const m = model();
    m.surface({
      patches: [
        { surface: rect(0, 1, 1), name: 'a' },
        { surface: rect(1, 1, 1), name: 'b' },
      ],
      chord: 0.5,
    });
    expect(info(m.uv.fromPatch({ mode: 'conformalScaled' }))?.groups).toBe(2);
  });

  it('two patches that agree on one end of a shared edge only are still two groups', () => {
    const m = model();
    m.surface({
      patches: [
        { surface: rect(0, 1, 1), name: 'a' },
        { surface: rect(1, 1, 1), name: 'b' },
      ],
      chord: 0.5,
    });
    const mesh = m.editMesh;
    const shared = (p: Float32Array | number[]) =>
      Math.abs((p[0] as number) - 1) < 1e-9 && Math.abs(p[2] as number) < 1e-9;
    const aFace = facesOf(m, 'a')[0] as number;
    const at = mesh
      .faceHalves(aFace)
      .find((h) => shared(mesh.position(mesh.hVert[h] as number))) as number;
    const want = Array.from(mesh.corner('uv1', at) as Float32Array);
    for (const f of facesOf(m, 'b'))
      for (const h of mesh.faceHalves(f))
        if (shared(mesh.position(mesh.hVert[h] as number))) mesh.setCorner('uv1', h, want);
    expect(info(m.uv.fromPatch({ mode: 'conformalScaled' }))?.groups).toBe(2);
  });

  it('falsifier: a collapsed or vanishing domain is skipped with a warning and keeps its uv0', () => {
    for (const squash of [
      (_c: Float32Array): [number, number] => [0.5, 0.5],
      (c: Float32Array): [number, number] => [(c[0] as number) * 1e-7, (c[1] as number) * 1e-7],
    ]) {
      const m = strips();
      const before = uv0Of(m);
      mapUv1(m, 'long', squash);
      const r = m.uv.fromPatch({ mode: 'conformalScaled' });
      expect(r.status).toBe('ok');
      expect(info(r)).toMatchObject({ groups: 1, skipped: 1 });
      expect(r.diagnostics?.some((d) => d.detail?.code === 'degenerate-domain')).toBe(true);
      const after = uv0Of(m);
      const long = new Set(facesOf(m, 'long').map((f) => f));
      let i = 0;
      for (const f of m.editMesh.faces()) {
        for (const _h of m.editMesh.faceHalves(f)) {
          if (long.has(f)) expect(after[i]).toEqual(before[i]);
          i++;
        }
      }
    }
  });

  it('period and zone errors carry a code and leave uv0 unchanged', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ mode: 'intrinsic', period: 2 }, 'period'],
      [{ mode: 'conformalScaled', period: Number.NaN }, 'period'],
      [{ mode: 'conformalScaled', zone: [1e300, 0] }, 'zone'],
      [{ mode: 'conformalScaled', zone: [0, -1025] }, 'zone'],
      [{ mode: 'conformalScaled', zone: [0, Number.POSITIVE_INFINITY] }, 'zone'],
      [{ mode: 'conformalScaled', period: 1e-40 }, 'overflow'],
      [{ mode: 'conformalScaled', period: Number.POSITIVE_INFINITY }, 'period'],
      [{ mode: 'conformalScaled', period: -1 }, 'period'],
      [{ mode: 'conformalScaled', period: 0 }, 'period'],
      [{ mode: 'conformalScaled', period: -0 }, 'period'],
      [{ mode: 'conformalScaled', zone: [0.5, 0] }, 'zone'],
      [{ mode: 'conformalScaled', zone: [0, 0.5] }, 'zone'],
      [{ mode: 'conformalScaled', zone: [Number.NaN, 0] }, 'zone'],
      [{ mode: 'conformalScaled', zone: [0, Number.NaN] }, 'zone'],
      [{ mode: 'conformalScaled', zone: [1025, 0] }, 'zone'],
      [{ mode: 'conformalScaled', zone: [-1025, 0] }, 'zone'],
      [{ mode: 'conformalScaled', zone: [0, 1025] }, 'zone'],
      [{ mode: 'conformalScaled', period: 1e-38 }, 'overflow'],
    ];
    for (const [options, code] of cases) {
      const m = strips();
      const before = uv0Of(m);
      const r = m.uv.fromPatch(options as never);
      expect(r.status).toBe('failed');
      expect(JSON.stringify(r.error)).toContain(`"code":"${code}"`);
      expect(uv0Of(m)).toEqual(before);
    }
  });

  it('falsifier: overflow on the v axis alone is still refused', () => {
    const m = model();
    m.surface({ patches: [{ surface: rect(0, 1, 8), name: 'tall' }], chord: 0.01 });
    const before = uv0Of(m);
    const r = m.uv.fromPatch({ mode: 'conformalScaled', period: 1e-38 });
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r.error)).toContain('"code":"overflow"');
    expect(uv0Of(m)).toEqual(before);
  });

  it('falsifier: zone [1e300, 0] never writes Infinity into uv0', () => {
    const m = strips();
    m.uv.fromPatch({ mode: 'conformalScaled', zone: [1e300, 0] } as never);
    for (const c of uv0Of(m)) for (const v of c) expect(Number.isFinite(v)).toBe(true);
  });

  it('the largest allowed cell is accepted and keeps the local fraction', () => {
    const m = cylinders();
    expect(m.uv.fromPatch({ mode: 'intrinsic', zone: [1024, -1024] }).status).toBe('ok');
    const cs = uv0Of(m);
    expect(
      cs.every(
        (c) =>
          (c[0] as number) >= 1024 &&
          (c[0] as number) <= 1025 &&
          (c[1] as number) >= -1024 &&
          (c[1] as number) <= -1023,
      ),
    ).toBe(true);
    expect(new Set(cs.map((c) => c[0] as number)).size).toBeGreaterThan(2);
  });
});
