import { describe, expect, it } from 'vitest';
import { booleanOp } from '../boolean';
import { traceBoundaryLoops } from '../connect';
import { cos, sin } from '../dmath';
import { add, cross, dot, normalize, scale, type Tuple3 } from '../geom';
import { debugValidate } from '../invariants';
import { EditMesh, NONE } from '../mesh';
import {
  type BallCylinder,
  type BallStation,
  cylinderPairStation,
  stationCount,
} from '../weld-ball';
import { branchField, cutAlongField, hostField } from '../weld-cut';

const R = 0.1;
const TAU = 2 * Math.PI;

function frameOf(u: Tuple3): [Tuple3, Tuple3] {
  const lead =
    Math.abs(u[0]) <= Math.abs(u[1]) && Math.abs(u[0]) <= Math.abs(u[2])
      ? 0
      : Math.abs(u[1]) <= Math.abs(u[2])
        ? 1
        : 2;
  const reference: Tuple3 = [0, 0, 0];
  reference[lead] = 1;
  const e1 = normalize(cross(u, reference));
  return [e1, cross(u, e1)];
}

function tube(
  m: EditMesh,
  from: Tuple3,
  u: Tuple3,
  radius: number,
  stops: readonly number[],
  names: readonly string[],
  ring: number,
) {
  const [e1, e2] = frameOf(u);
  const rows = stops.map((t) => {
    const ids: number[] = [];
    for (let k = 0; k < ring; k++) {
      const a = (TAU * (k + 0.5)) / ring;
      const p = add(
        add(from, scale(u, t)),
        scale(add(scale(e1, cos(a)), scale(e2, sin(a))), radius),
      );
      ids.push(m.addVertex(p[0], p[1], p[2]));
    }
    return ids;
  });
  const role = m.nameIndex(m.roleNames, 'strut');
  for (let s = 0; s + 1 < rows.length; s++) {
    const a = rows[s] as number[];
    const b = rows[s + 1] as number[];
    const label = m.nameIndex(m.labelNames, names[s] as string);
    for (let k = 0; k < ring; k++) {
      const k1 = (k + 1) % ring;
      const f = m.addFace([a[k] as number, a[k1] as number, b[k1] as number, b[k] as number]);
      if (!f.ok) throw new Error('tube face');
      m.fLabel[f.value] = label;
      m.fRole[f.value] = role;
    }
  }
  const cap = m.nameIndex(m.labelNames, 'cap');
  const first = rows[0] as number[];
  const last = rows[rows.length - 1] as number[];
  for (const loop of [[...first].reverse(), last]) {
    const f = m.addFace(loop);
    if (!f.ok) throw new Error('cap face');
    m.fLabel[f.value] = cap;
  }
}

function union(rb: number, ring: number): EditMesh {
  const host = new EditMesh();
  tube(host, [0, 0, 0], [1, 0, 0], R, [-1, 0, 1], ['strut:0', 'strut:1'], ring);
  const branch = new EditMesh();
  tube(branch, [0, 0, 0], [0, 1, 0], rb, [0, 1], ['strut:2'], ring);
  const joined = booleanOp(
    host,
    'union',
    { mesh: branch },
    {},
    { label: 0, material: 0, tag: -1 },
    { tolerance: 1e-5, policy: 'ts' },
    [],
  );
  if (!joined.ok) throw new Error(`union ${JSON.stringify(joined.error.detail)}`);
  return host;
}

interface Joint {
  readonly mesh: EditMesh;
  readonly host: BallCylinder;
  readonly branch: BallCylinder;
  readonly stations: BallStation[];
}

function joint(rb: number, rho: number, ring: number): Joint {
  const apothem = cos(Math.PI / ring);
  const host: BallCylinder = {
    kind: 'cylinder',
    origin: [0, 0, 0],
    axis: [1, 0, 0],
    radius: R * apothem,
  };
  const branch: BallCylinder = {
    kind: 'cylinder',
    origin: [0, 0, 0],
    axis: [0, 1, 0],
    radius: rb * apothem,
  };
  const count = stationCount(branch.radius, rho);
  const stations: BallStation[] = [];
  for (let i = 0; i < count; i++) {
    const s = cylinderPairStation(host, branch, rho, (TAU * (i + 0.5)) / count, 1);
    if (s === undefined) throw new Error('no ball');
    stations.push(s);
  }
  return { mesh: union(rb, ring), host, branch, stations };
}

const CASES = [
  ['tee', 0.07],
  ['equal tee', R],
] as const;

describe('weld cutter: faces split exactly along the contact polylines', () => {
  for (const [name, rb] of CASES) {
    for (const rho of [0.01, 0.03, 0.05]) {
      it(`${name}, ring 32, rho ${rho}: one closed loop per side, cut degree 2, valid`, () => {
        const { mesh, host, branch, stations } = joint(rb, rho, 32);
        const named = (n: string) => mesh.labelNames.indexOf(n);
        const hostLabels = new Set([named('strut:0'), named('strut:1')]);
        const hostFaces = mesh.faces().filter((f) => hostLabels.has(mesh.fLabel[f] as number));
        const branchFaces = mesh.faces().filter((f) => mesh.fLabel[f] === named('strut:2'));
        const hf = hostField(
          host,
          branch,
          stations.map((s) => s.contactA),
        );
        const bf = branchField(
          branch,
          stations.map((s) => s.contactB),
        );
        if (!hf.ok || !bf.ok) throw new Error('field');
        const cutHost = cutAlongField(mesh, hostFaces, hf.value, {
          maxDeviation: 0.05 * rho,
          maxShift: 1.0 * rho,
        });
        expect(cutHost.ok).toBe(true);
        const cutBranch = cutAlongField(mesh, branchFaces, bf.value, {
          maxDeviation: 0.05 * rho,
          maxShift: 1.0 * rho,
        });
        expect(cutBranch.ok).toBe(true);
        if (!cutHost.ok || !cutBranch.ok) return;
        expect(debugValidate(mesh)).toEqual([]);

        for (const cut of [cutHost.value, cutBranch.value]) {
          const degree = new Map<number, number>();
          for (const [a, b] of cut.edges) {
            degree.set(a, (degree.get(a) ?? 0) + 1);
            degree.set(b, (degree.get(b) ?? 0) + 1);
          }
          expect([...degree.values()].every((d) => d === 2)).toBe(true);
          expect(cut.loop.length).toBe(degree.size);
          expect(cut.keys.length).toBe(cut.loop.length);
          for (let i = 1; i < cut.keys.length; i++) {
            expect(cut.keys[i] as number).toBeGreaterThan(cut.keys[i - 1] as number);
          }
          for (let i = 0; i < cut.loop.length; i++) {
            const a = cut.loop[i] as number;
            const b = cut.loop[(i + 1) % cut.loop.length] as number;
            expect(mesh.findHalf(a, b)).not.toBe(NONE);
          }
          expect(cut.band.length).toBeGreaterThan(0);
          expect(cut.deviation).toBeLessThan(0.8 * rho);
        }

        for (const f of [...cutHost.value.band, ...cutBranch.value.band]) mesh.removeFace(f);
        const boundary = mesh.edges().filter((e) => mesh.isBoundaryEdge(e));
        const traced = traceBoundaryLoops(mesh, boundary);
        expect(traced.ok).toBe(true);
        if (!traced.ok) return;
        expect(traced.value.length).toBe(2);
        const hostSet = new Set(cutHost.value.loop);
        const branchSet = new Set(cutBranch.value.loop);
        const sets = traced.value.map(
          (l) => l.every((v) => hostSet.has(v)) || l.every((v) => branchSet.has(v)),
        );
        expect(sets).toEqual([true, true]);
      });
    }
  }

  it('refuses a field that crosses the edge of its face set', () => {
    const { mesh, host, branch, stations } = joint(0.07, 0.03, 16);
    const hf = hostField(
      host,
      branch,
      stations.map((s) => s.contactA),
    );
    if (!hf.ok) throw new Error('field');
    const some = mesh.faces().filter((f) => mesh.fLabel[f] === mesh.labelNames.indexOf('strut:0'));
    const cut = cutAlongField(mesh, some, hf.value);
    expect(cut.ok).toBe(false);
    expect(dot([1, 0, 0], [1, 0, 0])).toBe(1);
  });

  it('refuses a polyline that is not star-shaped about its axis', () => {
    const branch: BallCylinder = {
      kind: 'cylinder',
      origin: [0, 0, 0],
      axis: [0, 1, 0],
      radius: 0.07,
    };
    const bad: Tuple3[] = [
      [0.07, 0.1, 0],
      [0, 0.1, 0.07],
      [0.07, 0.1, 0.0001],
      [-0.07, 0.1, 0],
    ];
    expect(branchField(branch, bad).ok).toBe(false);
  });
});
