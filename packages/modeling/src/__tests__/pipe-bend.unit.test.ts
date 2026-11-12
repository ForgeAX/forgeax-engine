import { describe, expect, it } from 'vitest';
import { add, cross, dot, length, normalize, scale, sub, type Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { regen } from '../regen';
import { faceSizes } from './contract';

const R = 0.05;
const BEND = 0.15;

interface Path {
  readonly nodes: Tuple3[];
  readonly edges: [number, number][];
}

function chain(points: Tuple3[]): Path {
  return { nodes: points, edges: points.slice(1).map((_, i) => [i, i + 1] as [number, number]) };
}

const L90 = chain([
  [0, 0, 0],
  [0.5, 0, 0],
  [0.5, 0.5, 0],
]);
const L135 = chain([
  [0, 0, 0],
  [0.5, 0, 0],
  [0.5 + 0.35, 0.35, 0],
]);
const L45 = chain([
  [0, 0, 0],
  [0.5, 0, 0],
  [0.5 + 0.35, -0.35, 0],
]);
const S3D = chain([
  [0, 0, 0],
  [0.5, 0, 0],
  [0.5, 0.5, 0],
  [0.5, 0.5, 0.5],
]);
const U = chain([
  [-0.4, 0.5, 0],
  [-0.4, 0, 0],
  [0.4, 0, 0],
  [0.4, 0.5, 0],
]);

function build(path: Path, bend: object | null = { radius: BEND }, extra: object = {}) {
  const m = model();
  const report = m.pipeNetwork({
    nodes: path.nodes,
    edges: path.edges,
    radius: R,
    ...(bend === null ? {} : { bend }),
    ...extra,
  } as never);
  return { m, report };
}

function perLabel(m: Model): Record<string, number> {
  const mesh = m.editMesh;
  const per: Record<string, number> = {};
  for (const f of mesh.faces()) {
    const key = `${mesh.labelNames[mesh.fLabel[f] as number]}/${mesh.roleNames[mesh.fRole[f] as number]}`;
    per[key] = (per[key] ?? 0) + 1;
  }
  return per;
}

/** Distances from the axis through `at` of the mesh's edge crossings with the plane normal to it. */
function radiiAt(m: Model, at: Tuple3, axis: Tuple3, reach: number): number[] {
  const mesh = m.editMesh;
  const out: number[] = [];
  const signed = (v: number) => dot(sub(mesh.position(v), at), axis);
  for (const e of mesh.edges()) {
    const a = mesh.hVert[e * 2] as number;
    const b = mesh.hVert[e * 2 + 1] as number;
    const da = signed(a);
    const db = signed(b);
    if (!((da <= 0 && db > 0) || (da > 0 && db <= 0))) continue;
    const p = add(mesh.position(a), scale(sub(mesh.position(b), mesh.position(a)), da / (da - db)));
    const rel = sub(p, at);
    const r = length(sub(rel, scale(axis, dot(rel, axis))));
    if (r < reach) out.push(r);
  }
  return out;
}

/** Independent arc of the elbow at `node` of a chain: centre, start, directions and turn. */
function elbow(path: Path, node: number, radius: number) {
  const here = path.nodes[node] as Tuple3;
  const tIn = normalize(sub(here, path.nodes[node - 1] as Tuple3));
  const tOut = normalize(sub(path.nodes[node + 1] as Tuple3, here));
  const c = dot(tIn, tOut);
  const turn = Math.acos(c);
  const tangent = radius * Math.tan(turn / 2);
  const start = sub(here, scale(tIn, tangent));
  const toCentre = normalize(sub(tOut, scale(tIn, c)));
  const centre = add(start, scale(toCentre, radius));
  return { tIn, tOut, turn, tangent, start, toCentre, centre };
}

function stationRadii(m: Model, path: Path, node: number, fraction: number) {
  const a = elbow(path, node, BEND);
  const psi = a.turn * fraction;
  const point = add(
    a.centre,
    add(scale(a.toCentre, -BEND * Math.cos(psi)), scale(a.tIn, BEND * Math.sin(psi))),
  );
  const axis = add(scale(a.tIn, Math.cos(psi)), scale(a.toCentre, Math.sin(psi)));
  return radiiAt(m, point, axis, 1.6 * R);
}

function roundness(radii: readonly number[]): number {
  const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
  return (Math.max(...radii) - Math.min(...radii)) / mean;
}

function expectSolid(m: Model) {
  const report = m.validate({ watertight: true });
  expect(report.closed).toBe(true);
  expect(report.pass).toBe(true);
  expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  expect(m.validate().issues.filter((i) => i.code === 'self-intersection')).toEqual([]);
  const mesh = m.editMesh;
  expect(mesh.edges().every((e) => !mesh.isBoundaryEdge(e))).toBe(true);
}

describe('pipeNetwork bend', () => {
  for (const [name, path] of [
    ['90 degree', L90],
    ['135 degree', L135],
    ['45 degree', L45],
    ['3D double', S3D],
    ['U', U],
  ] as const) {
    it(`builds an all-quad manifold watertight ${name} elbow without self-intersection`, () => {
      const { m, report } = build(path);
      expect(report.status).toBe('ok');
      expect(Object.keys(faceSizes(m.editMesh))).toEqual(['4']);
      expectSolid(m);
    });
  }

  it('keeps the section radius within 4 % and round within 4 % along every elbow', () => {
    for (const path of [L90, L135, L45, S3D, U]) {
      const { m } = build(path);
      for (let node = 1; node < path.nodes.length - 1; node++) {
        for (const t of [0.15, 0.3, 0.5, 0.7, 0.85]) {
          const radii = stationRadii(m, path, node, t);
          expect(radii.length).toBeGreaterThan(8);
          const worst = Math.max(...radii.map((r) => Math.abs(r - R) / R));
          expect(worst).toBeLessThan(0.04);
          expect(roundness(radii)).toBeLessThan(0.04);
        }
      }
    }
  });

  it('follows the requested centreline radius: outer and inner wall in the bend plane', () => {
    const { m } = build(L90);
    const a = elbow(L90, 1, BEND);
    const mesh = m.editMesh;
    const ds: number[] = [];
    for (const e of mesh.edges()) {
      const p = mesh.position(mesh.hVert[e * 2] as number);
      const q = mesh.position(mesh.hVert[e * 2 + 1] as number);
      const dp = p[2] as number;
      const dq = q[2] as number;
      if (!((dp <= 0 && dq > 0) || (dp > 0 && dq <= 0))) continue;
      const x = add(p, scale(sub(q, p), dp / (dp - dq)));
      const rel = sub(x, a.centre);
      const ang = Math.atan2(dot(rel, a.tIn), -dot(rel, a.toCentre));
      if (ang > 0.2 && ang < a.turn - 0.2) ds.push(length(rel));
    }
    expect(Math.max(...ds)).toBeGreaterThan((BEND + R) * 0.99);
    expect(Math.max(...ds)).toBeLessThan((BEND + R) * 1.01);
    expect(Math.min(...ds)).toBeGreaterThan((BEND - R) * 0.99);
    expect(Math.min(...ds)).toBeLessThan((BEND - R) * 1.01);
  });

  it('labels the elbow node:<i> with role bend and keeps strut and leaf labels', () => {
    const { m } = build(L90);
    const per = perLabel(m);
    expect(Object.keys(per).sort()).toEqual([
      'node:0/cap',
      'node:1/bend',
      'node:2/cap',
      'strut:0/strut',
      'strut:1/strut',
    ]);
    expect(per['node:1/bend']).toBe(6 * 8 * 4);
  });

  it('refuses a bend radius under 1.25 tube radii with a structured error and no faces', () => {
    for (const radius of [0.03, R, 0.06]) {
      const { m, report } = build(L90, { radius });
      expect(report.status).toBe('failed');
      expect(report.error?.code).toBe('model-precondition');
      expect(report.error?.detail?.reason).toBe('bend-radius');
      expect(report.error?.detail?.node).toBe(1);
      expect(m.editMesh.faceCount).toBe(0);
    }
  });

  it('accepts the tightest allowed bend without a fold or self-intersection', () => {
    const radius = 1.25 * R;
    for (const path of [L90, L135, U]) {
      const { m, report } = build(path, { radius });
      expect(report.status).toBe('ok');
      expectSolid(m);
    }
  });

  it('measures the bend against the largest of the two tube radii', () => {
    const { report } = build(L90, { radius: 0.07 }, { edgeRadius: [0.04, 0.06] });
    expect(report.status).toBe('failed');
    expect(report.error?.detail?.reason).toBe('bend-radius');
    const ok = build(L90, { radius: 0.08 }, { edgeRadius: [0.04, 0.06] });
    expect(ok.report.status).toBe('ok');
    expectSolid(ok.m);
  });

  it('faces every elbow quad away from the centreline', () => {
    const { m } = build(S3D);
    const mesh = m.editMesh;
    for (const f of mesh.faces()) {
      if (mesh.roleNames[mesh.fRole[f] as number] !== 'bend') continue;
      const loop = mesh.faceVertices(f).map((v) => mesh.position(v));
      const n = cross(
        sub(loop[1] as Tuple3, loop[0] as Tuple3),
        sub(loop[3] as Tuple3, loop[0] as Tuple3),
      );
      const mid = scale(
        loop.reduce((t, p) => add(t, p), [0, 0, 0] as Tuple3),
        1 / loop.length,
      );
      const owner = Number(mesh.labelNames[mesh.fLabel[f] as number]?.split(':')[1]);
      const a = elbow(S3D, owner, BEND);
      const rel = sub(mid, a.centre);
      const psi = Math.atan2(dot(rel, a.tIn), -dot(rel, a.toCentre));
      const onArc = add(
        a.centre,
        add(scale(a.toCentre, -BEND * Math.cos(psi)), scale(a.tIn, BEND * Math.sin(psi))),
      );
      expect(dot(n, sub(mid, onArc))).toBeGreaterThan(0);
    }
    expect(m.validate({ watertight: true }).pass).toBe(true);
  });

  it('is deterministic: identical snapshot bytes', () => {
    expect(build(S3D).m.snapshot()).toEqual(build(S3D).m.snapshot());
    expect(build(U, { radius: BEND, segments: 6 }).m.snapshot()).toEqual(
      build(U, { radius: BEND, segments: 6 }).m.snapshot(),
    );
  });

  it('is mirror symmetric in x for the symmetric U', () => {
    const { m } = build(U);
    const mesh = m.editMesh;
    const xs = mesh
      .faces()
      .flatMap((f) => mesh.faceVertices(f).map((v) => mesh.position(v)[0] as number));
    expect(Math.abs(Math.max(...xs) + Math.min(...xs))).toBeLessThan(1e-9);
    const left = stationRadii(m, U, 1, 0.5);
    const right = stationRadii(m, U, 2, 0.5);
    expect(Math.abs(roundness(left) - roundness(right))).toBeLessThan(2e-2);
    const mean = (v: number[]) => v.reduce((s, r) => s + r, 0) / v.length;
    expect(Math.abs(mean(left) - mean(right))).toBeLessThan(5e-4);
    let a = 0;
    let b = 0;
    for (const f of mesh.faces()) {
      const loop = mesh.faceVertices(f).map((v) => mesh.position(v));
      let area = 0;
      for (let k = 1; k + 1 < loop.length; k++) {
        const o = loop[0] as Tuple3;
        area += length(cross(sub(loop[k] as Tuple3, o), sub(loop[k + 1] as Tuple3, o))) / 2;
      }
      const cx = loop.reduce((t, p) => t + (p[0] as number), 0) / loop.length;
      if (cx > 0) a += area;
      else b += area;
    }
    expect(Math.abs(a - b) / (a + b)).toBeLessThan(0.01);
  });

  it('keeps labels, roles and per-label counts when the size changes (regen, B27)', () => {
    const job = (k: number) => {
      const m = model();
      m.pipeNetwork({
        nodes: S3D.nodes.map((p) => scale(p, k)),
        edges: S3D.edges,
        radius: R * k,
        bend: { radius: BEND * k },
      });
      return m;
    };
    const result = regen(job, [1, 0.8, 1.2]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings.map((f) => f.message)).toEqual([]);
    expect(perLabel(job(0.8))).toEqual(perLabel(job(1.2)));
  });

  it('rows follow the turn: 15 degrees per row, at least two, or the explicit segments', () => {
    const rows = (path: Path, bend: object) => perLabel(build(path, bend).m)['node:1/bend'];
    expect(rows(L90, { radius: BEND })).toBe(6 * 8 * 4);
    expect(rows(L45, { radius: BEND })).toBe(3 * 8 * 4);
    expect(rows(L90, { radius: BEND, segments: 3 })).toBe(3 * 8 * 4);
    expect(rows(L135, { radius: BEND, segments: 5 })).toBe(5 * 8 * 4);
    expect(build(L135, { radius: BEND, segments: 1 }).report.error?.detail?.reason).toBe(
      'bend-segments',
    );
  });

  it('bends only the listed nodes and leaves the rest as joints', () => {
    const { m, report } = build(S3D, { radius: BEND, nodes: [2] });
    expect(report.status).toBe('ok');
    const per = perLabel(m);
    expect(per['node:2/bend']).toBeGreaterThan(0);
    expect(per['node:1/node']).toBeGreaterThan(0);
    expectSolid(m);
  });

  it('is byte-identical to the plain network when no node is bent', () => {
    expect(build(S3D, { radius: BEND, nodes: [] }).m.snapshot()).toEqual(
      build(S3D, null).m.snapshot(),
    );
  });

  it('builds a planar closed loop of elbows and refuses a skew one', () => {
    const square = chain([
      [0, 0, 0],
      [0.6, 0, 0],
      [0.6, 0.6, 0],
      [0, 0.6, 0],
    ]);
    const loop = { nodes: square.nodes, edges: [...square.edges, [3, 0] as [number, number]] };
    const planar = build(loop);
    expect(planar.report.status).toBe('ok');
    expectSolid(planar.m);
    const skew = chain([
      [0, 0, 0],
      [0.6, 0, 0],
      [0.6, 0.6, 0.1],
      [0, 0.6, 0.45],
    ]);
    const bad = build({ nodes: skew.nodes, edges: [...skew.edges, [3, 0] as [number, number]] });
    expect(bad.report.status).toBe('failed');
    expect(bad.report.error?.code).toBe('model-precondition');
    expect(bad.report.error?.detail?.reason).toBe('bend-loop');
    expect(bad.m.editMesh.faceCount).toBe(0);
  });

  it('rejects malformed bend options with model-invalid-argument', () => {
    const cases: [object, number | undefined][] = [
      [{ radius: 0 }, undefined],
      [{ radius: -1 }, undefined],
      [{ radius: Number.NaN }, undefined],
      [{ radius: BEND, segments: 0 }, undefined],
      [{ radius: BEND, segments: 65 }, undefined],
      [{ radius: BEND, segments: 2.5 }, undefined],
      [{ radius: BEND, nodes: [0] }, undefined],
      [{ radius: BEND, nodes: [9] }, undefined],
      [{ radius: BEND, nodes: [1.5] }, undefined],
    ];
    for (const [bend] of cases) {
      const { m, report } = build(L90, bend);
      expect(report.status).toBe('failed');
      expect(report.error?.code).toBe('model-invalid-argument');
      expect(m.editMesh.faceCount).toBe(0);
    }
    const welded = build(L90, { radius: BEND }, { weld: { radius: 0.01 } });
    expect(welded.report.error?.code).toBe('model-invalid-argument');
  });

  it('keeps a strut that is too short for its two tangent lengths a precondition error', () => {
    const short = chain([
      [0, 0, 0],
      [0.5, 0, 0],
      [0.5, 0.2, 0],
      [0, 0.2, 0],
    ]);
    const { m, report } = build(short, { radius: 0.2 });
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('model-precondition');
    expect(report.error?.detail?.reason).toBe('edge-short');
    expect(m.editMesh.faceCount).toBe(0);
  });

  it('reports the measured bend section in a diagnostic', () => {
    const { report } = build(L90);
    const found = report.diagnostics?.find((d) => d.message.includes('bend stations'));
    expect(found?.severity).toBe('info');
    const bends = (found?.detail as { bends: { roundness: number }[] }).bends;
    expect(bends.length).toBeGreaterThanOrEqual(7);
    expect(Math.max(...bends.map((b) => b.roundness))).toBeLessThan(0.05);
  });
});
