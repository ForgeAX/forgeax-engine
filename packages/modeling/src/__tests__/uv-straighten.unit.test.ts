import { describe, expect, it } from 'vitest';
import { WorkMeter } from '../compute/job';
import { rejection } from '../compute/uv-straighten';
import { channelIslands, type Island, measureUv, metricsOf, samplesOf } from '../compute/uv-ts';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

type Info = {
  chains: number;
  straightened: number;
  maxAngleError: number;
  verdicts: Record<string, number>;
  islands: { status: string; angleBefore: number; stretchBefore: number; stretchAfter: number }[];
};

function info(report: OpReport): Info {
  const d = report.diagnostics?.filter((x) => x.severity === 'info').at(-1);
  if (d === undefined) throw new Error(`${report.op}: ${report.error?.message}`);
  return d.detail as unknown as Info;
}

/** Triangulated cols x rows grid panel in the plane z = 0; the bottom edge wobbles by `wobble` meters. */
function panel(cols: number, rows: number, wobble: number, taper = 0): Model {
  const m = model();
  const mesh = m.editMesh;
  const at: number[][] = [];
  for (let j = 0; j <= rows; j++) {
    at.push([]);
    for (let i = 0; i <= cols; i++) {
      const squeeze = 1 - (taper * j) / rows;
      const x = (i - cols / 2) * squeeze;
      const y = j + (j === 0 ? wobble * Math.sin(i * 1.7) : 0);
      (at[j] as number[]).push(mesh.addVertex(x, y, 0));
    }
  }
  const v = (i: number, j: number) => (at[j] as number[])[i] as number;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const [a, b, c, d] = [v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)];
      const t1 = (i + j) % 2 === 0 ? [a, b, c] : [a, b, d];
      const t2 = (i + j) % 2 === 0 ? [a, c, d] : [b, c, d];
      for (const t of [t1, t2]) {
        const f = mesh.addFace(t);
        if (!f.ok) throw f.error;
      }
    }
  }
  m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
  return m;
}

describe('uv.straighten', () => {
  it('puts a wavy trapezoid boundary on its chords within 1 degree (exit criterion)', () => {
    const m = panel(8, 5, 0.12, 0.3);
    const before = measureUv(m.editMesh);
    if (!before.ok) throw before.error;
    const r = m.uv.straighten();
    expect(r.status).toBe('ok');
    const i = info(r);
    expect(i.chains).toBeGreaterThan(0);
    expect(i.straightened).toBe(i.chains);
    expect(i.maxAngleError).toBeLessThanOrEqual(1);
    expect(i.islands[0]?.angleBefore).toBeGreaterThan(3);
    const after = measureUv(m.editMesh);
    if (!after.ok) throw after.error;
    expect(after.value.flipped).toBe(0);
    expect(after.value.stretchLinf).toBeLessThanOrEqual(before.value.stretchLinf * 1.15 + 1e-9);
  });

  it('keeps an island that would stretch beyond maxStretch, byte for byte, and names the verdict', () => {
    const m = panel(8, 5, 0.12, 0.3);
    const before = cornersOf(m);
    const r = m.uv.straighten({ maxStretch: 1 });
    expect(r.status).toBe('ok');
    const i = info(r);
    expect(i.verdicts.stretch).toBe(1);
    expect(i.straightened).toBe(0);
    expect(cornersOf(m)).toEqual(before);
    expect(
      (r.diagnostics ?? []).some((d) => d.severity === 'warn' && /keep their UVs/.test(d.message)),
    ).toBe(true);
  });

  it('keeps an island whose straightened chain would fold it', () => {
    const m = panel(6, 1, -0.9);
    const before = cornersOf(m);
    const r = m.uv.straighten({ maxAngle: 80 });
    expect(r.status).toBe('ok');
    const i = info(r);
    expect(i.straightened).toBe(0);
    expect(i.islands[0]?.status).toBe('stretch');
    expect(cornersOf(m)).toEqual(before);
    const after = measureUv(m.editMesh);
    if (!after.ok) throw after.error;
    expect(after.value.flipped).toBe(0);
  });

  it('leaves a straight island untouched', () => {
    const m = panel(5, 4, 0);
    const before = cornersOf(m);
    const i = info(m.uv.straighten());
    expect(i.islands[0]?.angleBefore).toBeLessThan(1e-3);
    expect(cornersOf(m)).toEqual(before);
  });

  it('only straightens chains with a selected edge', () => {
    const rim = info(panel(8, 5, 0.12, 0.3).uv.straighten({ edges: sel.edges.meshBoundary() }));
    expect(rim.straightened).toBe(rim.chains);
    const horizontal = panel(8, 5, 0.12, 0.3);
    const some = info(horizontal.uv.straighten({ edges: sel.edges.parallel('x', 30) }));
    expect(some.straightened).toBeGreaterThan(0);
    expect(some.straightened).toBeLessThan(some.chains);
    const nothing = panel(8, 5, 0.12, 0.3);
    const before = cornersOf(nothing);
    expect(nothing.uv.straighten({ edges: sel.edges.dihedral('>', 170) }).error?.code).toBe(
      'model-selection-empty',
    );
    expect(cornersOf(nothing)).toEqual(before);
  });

  it('requires uv0 on every face', () => {
    const m = model();
    const mesh = m.editMesh;
    const f = mesh.addFace([
      mesh.addVertex(0, 0, 0),
      mesh.addVertex(1, 0, 0),
      mesh.addVertex(0, 1, 0),
    ]);
    if (!f.ok) throw f.error;
    const r = m.uv.straighten();
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-precondition');
  });

  it('rejects out-of-range options', () => {
    expect(panel(4, 3, 0).uv.straighten({ maxAngle: 0 }).error?.code).toBe(
      'model-invalid-argument',
    );
    expect(panel(4, 3, 0).uv.straighten({ maxStretch: 0.9 }).error?.code).toBe(
      'model-invalid-argument',
    );
  });
});

describe('uv.straighten acceptance verdicts', () => {
  const setup = () => {
    const m = panel(8, 1, 0);
    const found = channelIslands(m.editMesh, 'uv0', new WorkMeter(Number.POSITIVE_INFINITY));
    if (!found.ok) throw found.error;
    const island = found.value.islands[0] as (typeof found.value.islands)[number];
    const at = island.vertexOf.map((v) => m.editMesh.position(v));
    const uv = (map: (x: number, y: number) => [number, number]) =>
      at.map((p) => map(p[0] as number, p[1] as number));
    return { m, island, uv };
  };

  it('keeps a candidate that changes nothing and names no verdict', () => {
    const { m, island, uv } = setup();
    const plain = uv((x, y) => [x, y]);
    expect(rejection(m.editMesh, island, plain, plain, 1.15)).toBeUndefined();
  });

  it('rejects a candidate with a flipped triangle', () => {
    const { m, island, uv } = setup();
    const plain = uv((x, y) => [x, y]);
    const mirrored = uv((x, y) => [x, -y]);
    expect(rejection(m.editMesh, island, plain, mirrored, 1.15)).toBe('flipped');
  });

  it('rejects a candidate stretched beyond maxStretch', () => {
    const { m, island, uv } = setup();
    const plain = uv((x, y) => [x, y]);
    const stretched = uv((x, y) => [x * 3, y]);
    expect(rejection(m.editMesh, island, plain, stretched, 1.15)).toBe('stretch');
    expect(rejection(m.editMesh, island, plain, stretched, 10)).toBeUndefined();
  });

  it('rejects a flip-free candidate that wraps over itself', () => {
    const { m, island, uv } = setup();
    const plain = uv((x, y) => [x, y]);
    const turns = 1.4;
    const wrapped = uv((x, y) => {
      const angle = (-(x + 4) / 8) * turns * 2 * Math.PI;
      const radius = 1 + y * 0.4;
      return [radius * Math.cos(angle), radius * Math.sin(angle)];
    });
    const check = measureUvOf(m, island, wrapped);
    expect(check.flipped + check.zeroArea).toBe(0);
    expect(rejection(m.editMesh, island, plain, wrapped, 1e6)).toBe('overlap');
  });
});

function cornersOf(m: Model): number[][] {
  const mesh = m.editMesh;
  return mesh
    .faces()
    .flatMap((f) => mesh.faceHalves(f).map((h) => Array.from(mesh.corner('uv0', h) ?? [])));
}

/** Two walls (z = 0 and x = 0 planes) and a floor, each meter-sized panel with its UV turned by `degrees`. */
function turnedWalls(degrees: number): Model {
  const m = model();
  const mesh = m.editMesh;
  const quad = (pts: readonly [number, number, number][]) => {
    const ids = pts.map(([x, y, z]) => mesh.addVertex(x, y, z));
    const f = mesh.addFace(ids);
    if (!f.ok) throw f.error;
  };
  quad([
    [0, 0, 0],
    [2, 0, 0],
    [2, 1, 0],
    [0, 1, 0],
  ]);
  quad([
    [5, 0, 0],
    [5, 0, 1],
    [5, 1, 1],
    [5, 1, 0],
  ]);
  quad([
    [8, 0, 0],
    [10, 0, 0],
    [10, 0, 1],
    [8, 0, 1],
  ]);
  m.uv.unwrap({ method: 'lscm' });
  const a = (degrees * Math.PI) / 180;
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      const v = mesh.corner('uv0', h) as Float32Array;
      mesh.setCorner('uv0', h, [
        (v[0] as number) * Math.cos(a) - (v[1] as number) * Math.sin(a),
        (v[0] as number) * Math.sin(a) + (v[1] as number) * Math.cos(a),
      ]);
    }
  }
  return m;
}

/** Angle in degrees between the UV image of world +Y over the face's edges and +v (0 = up is +v). */
function upError(m: Model, face: number): number {
  const mesh = m.editMesh;
  const halves = mesh.faceHalves(face);
  let worst = 0;
  for (const h of halves) {
    const g = mesh.hNext[h] as number;
    const p = mesh.position(mesh.hVert[h] as number);
    const q = mesh.position(mesh.hVert[g] as number);
    if (Math.abs(q[1] - p[1]) < 1e-9) continue;
    const s = Math.sign(q[1] - p[1]);
    const a = mesh.corner('uv0', h) as Float32Array;
    const b = mesh.corner('uv0', g) as Float32Array;
    const du = ((b[0] as number) - (a[0] as number)) * s;
    const dv = ((b[1] as number) - (a[1] as number)) * s;
    worst = Math.max(worst, Math.abs(Math.atan2(du, dv)) * (180 / Math.PI));
  }
  return worst;
}

describe('pack orient', () => {
  const PACK = { resolution: 256, padding: 2 } as const;

  it("'worldUp' puts world +Y on +v within 1 degree on walls and leaves a floor to 'straight'", () => {
    const m = turnedWalls(37);
    const walls = m.editMesh.faces();
    expect(m.uv.pack({ ...PACK, orient: 'worldUp' }).status).toBe('ok');
    expect(upError(m, walls[0] as number)).toBeLessThan(1);
    expect(upError(m, walls[1] as number)).toBeLessThan(1);
    const plain = turnedWalls(37);
    plain.uv.pack(PACK);
    expect(upError(plain, walls[0] as number)).toBeGreaterThan(1);
    const floor = turnedWalls(37);
    floor.uv.pack({ ...PACK, orient: 'worldUp' });
    const straight = turnedWalls(37);
    straight.uv.pack({ ...PACK, orient: 'straight' });
    const floorFace = walls[2] as number;
    const edge = (mm: Model) => {
      const corners = mm.editMesh
        .faceHalves(floorFace)
        .map((h) => mm.editMesh.corner('uv0', h) as Float32Array);
      const [a, b] = [corners[0] as Float32Array, corners[1] as Float32Array];
      return Math.atan2((b[1] as number) - (a[1] as number), (b[0] as number) - (a[0] as number));
    };
    expect(edge(floor)).toBeCloseTo(edge(straight), 3);
  });

  it("'worldUp' never turns an island by a quarter when packing", () => {
    const m = turnedWalls(90);
    m.uv.pack({ ...PACK, orient: 'worldUp', method: 'raster' });
    for (const face of m.editMesh.faces().slice(0, 2)) expect(upError(m, face)).toBeLessThan(1);
  });

  it("'straight' is the default and byte-identical to omitting orient", () => {
    const a = turnedWalls(23);
    const b = turnedWalls(23);
    a.uv.pack(PACK);
    b.uv.pack({ ...PACK, orient: 'straight' });
    expect(cornersOf(a)).toEqual(cornersOf(b));
  });

  it('rejects an unknown orient', () => {
    const m = turnedWalls(0);
    const r = m.uv.pack({ ...PACK, orient: 'north' as never });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-invalid-argument');
  });
});

function measureUvOf(m: Model, island: Island, uv: readonly [number, number][]) {
  return metricsOf(samplesOf(m.editMesh, island, uv as [number, number][]));
}
