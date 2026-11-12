import { describe, expect, it } from 'vitest';
import { add, dot, length, normalize, scale, sub, type Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { regen } from '../regen';
import { sel } from '../selectors';

const R = 0.05;
const BEND = 0.15;
const deg = (d: number) => (d * Math.PI) / 180;

/** Two struts of length `len` meeting at the origin with a turn of `turn` degrees. */
function corner(turn: number, len: number): Tuple3[] {
  const t = deg(turn);
  return [
    [-len, 0, 0],
    [0, 0, 0],
    [len * Math.cos(t), len * Math.sin(t), 0],
  ];
}

function build(
  nodes: Tuple3[],
  bend: object | null,
  extra: object = {},
  edges = [
    [0, 1],
    [1, 2],
  ],
) {
  const m = model();
  const report = m.pipeNetwork({
    nodes,
    edges,
    radius: R,
    ...(bend === null ? {} : { bend }),
    ...extra,
  } as never);
  return { m, report };
}

function reason(report: { error?: { detail?: Record<string, unknown> } }): unknown {
  return report.error?.detail?.reason;
}

/** Edge crossings of the plane through `at` normal to `axis`, as distances from the axis line. */
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

/** Independent arc of the elbow at node 1 of a two-strut chain. */
function arcOf(nodes: Tuple3[], radius: number) {
  const here = nodes[1] as Tuple3;
  const tIn = normalize(sub(here, nodes[0] as Tuple3));
  const tOut = normalize(sub(nodes[2] as Tuple3, here));
  const c = dot(tIn, tOut);
  const turn = Math.acos(c);
  const start = sub(here, scale(tIn, radius * Math.tan(turn / 2)));
  const toCentre = normalize(sub(tOut, scale(tIn, c)));
  const centre = add(start, scale(toCentre, radius));
  const at = (psi: number) =>
    add(centre, add(scale(toCentre, -radius * Math.cos(psi)), scale(tIn, radius * Math.sin(psi))));
  const axisAt = (psi: number) => add(scale(tIn, Math.cos(psi)), scale(toCentre, Math.sin(psi)));
  return { turn, start, tIn, tOut, at, axisAt };
}

/** Worst relative radius error and roundness over the stations `ts` (fractions of the turn). */
function sweep(m: Model, nodes: Tuple3[], radius: number, ts: readonly number[]) {
  const a = arcOf(nodes, radius);
  let dev = 0;
  let round = 0;
  for (const t of ts) {
    const radii = radiiAt(m, a.at(a.turn * t), a.axisAt(a.turn * t), 1.6 * R);
    expect(radii.length).toBeGreaterThan(4);
    const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
    dev = Math.max(dev, ...radii.map((r) => Math.abs(r - R) / R));
    round = Math.max(round, (Math.max(...radii) - Math.min(...radii)) / mean);
  }
  return { dev, round };
}

const FINE = Array.from({ length: 49 }, (_, i) => 0.02 + i * 0.02);

describe('pipeNetwork bend', () => {
  describe('A1 rows follow the turn', () => {
    it('refuses fewer than one row per 30 degrees as model-precondition bend-segments', () => {
      for (const [turn, segments] of [
        [135, 1],
        [135, 4],
        [160, 1],
        [160, 5],
        [90, 2],
        [45, 1],
      ] as const) {
        const nodes = corner(turn, 2);
        const { m, report } = build(nodes, { radius: BEND, segments });
        expect(report.status).toBe('failed');
        expect(report.error?.code).toBe('model-precondition');
        expect(reason(report)).toBe('bend-segments');
        expect(report.error?.detail?.node).toBe(1);
        expect(m.editMesh.faceCount).toBe(0);
      }
    });

    it('accepts exactly the minimum rows and builds a positive-volume solid', () => {
      for (const turn of [45, 90, 135, 160]) {
        const nodes = corner(turn, 2);
        const { m, report } = build(nodes, { radius: BEND, segments: Math.ceil(turn / 30) });
        expect(report.status).toBe('ok');
        const v = m.validate({ watertight: true });
        expect(v.volume).toBeGreaterThan(0);
        expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
        expect(v.pass).toBe(true);
      }
    });

    it('default rows give a positive-volume valid solid at every turn up to the branch limit', () => {
      for (const turn of [20, 60, 100, 135, 150, 164]) {
        const { m, report } = build(corner(turn, 2), { radius: BEND });
        expect(report.status).toBe('ok');
        const v = m.validate({ watertight: true });
        expect(v.volume).toBeGreaterThan(0);
        expect(v.pass).toBe(true);
      }
    });

    it('validate fails a closed inside-out component: mesh-inverted is an error', () => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      m.flip(sel.all());
      const v = m.validate();
      const inverted = v.issues.filter((i) => i.code === 'mesh-inverted');
      expect(inverted.length).toBe(1);
      expect(inverted[0]?.severity).toBe('error');
      expect(v.pass).toBe(false);
    });
  });

  describe('A2 end-section accuracy', () => {
    it('stays within 4 % radius and 6 % roundness from t = 0.02 to 0.98 at R = 3 r', () => {
      for (const turn of [45, 90, 135]) {
        const nodes = corner(turn, 2);
        const { m, report } = build(nodes, { radius: BEND });
        expect(report.status).toBe('ok');
        const worst = sweep(m, nodes, BEND, FINE);
        expect(worst.dev).toBeLessThan(0.04);
        expect(worst.round).toBeLessThan(0.06);
      }
    });

    it('holds at R = 10 r and R = 40 r within 3 % radius and 4.5 % roundness', () => {
      for (const ratio of [10, 40]) {
        const radius = ratio * R;
        const nodes = corner(90, radius + 12 * R);
        const { m, report } = build(nodes, { radius });
        expect(report.status).toBe('ok');
        const worst = sweep(m, nodes, radius, FINE);
        expect(worst.dev).toBeLessThan(0.03);
        expect(worst.round).toBeLessThan(0.045);
      }
    });

    it('keeps the section round on the straight strut next to the tangent point', () => {
      const nodes = corner(90, 2);
      const { m, report } = build(nodes, { radius: BEND });
      expect(report.status).toBe('ok');
      const a = arcOf(nodes, BEND);
      for (const d of [0, 0.005, 0.01, 0.02, 0.04]) {
        const radii = radiiAt(m, sub(a.start, scale(a.tIn, d)), a.tIn, 1.6 * R);
        const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
        expect(Math.max(...radii.map((r) => Math.abs(r - R) / R))).toBeLessThan(0.04);
        expect((Math.max(...radii) - Math.min(...radii)) / mean).toBeLessThan(0.06);
      }
    });

    it('reports a bend station list from t = 0.02 to 0.98 and records the worst roundness', () => {
      const { report } = build(corner(90, 2), { radius: BEND });
      const d = report.diagnostics?.find((x) => String(x.message).includes('bend stations'));
      const bends = (d?.detail as { bends: { at: number }[] }).bends;
      expect(Math.min(...bends.map((b) => b.at))).toBeLessThanOrEqual(0.02);
      expect(Math.max(...bends.map((b) => b.at))).toBeGreaterThanOrEqual(0.98);
      expect((d?.detail as { maxRoundness: number }).maxRoundness).toBeGreaterThan(0);
    });
  });

  describe('A4 regen reports a hub <-> bend flip', () => {
    it('names the pipeNetwork step when the turn crosses the default 2 degree threshold', () => {
      const job = (turn: number) => {
        const m = model();
        m.pipeNetwork({
          nodes: corner(turn, 1),
          edges: [
            [0, 1],
            [1, 2],
          ],
          radius: R,
          bend: { radius: BEND },
        } as never);
        return m;
      };
      const result = regen(job, [1.9, 2.1]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.pass).toBe(false);
      expect(result.value.findings.some((f) => f.op === 'pipeNetwork')).toBe(true);
    });
  });

  describe('A5 tiny explicit turns', () => {
    it('either refuses or yields a mesh that validates; never ok with a degenerate face', () => {
      for (const turn of [1e-9, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3]) {
        const { m, report } = build(corner(turn, 1), { radius: BEND, nodes: [1] });
        if (report.status === 'ok') {
          const v = m.validate({ watertight: true });
          expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
        } else {
          expect(reason(report)).toBe('bend-straight');
        }
      }
    });
  });

  describe('A6 branch angle before bend', () => {
    it('reports a 180 degree reversal as branch-angle', () => {
      for (const bend of [{ radius: BEND }, { radius: BEND, nodes: [1] }]) {
        const { report } = build(corner(180, 1), bend);
        expect(report.status).toBe('failed');
        expect(reason(report)).toBe('branch-angle');
      }
    });
  });

  describe('A7 malformed bend.nodes', () => {
    it('returns model-invalid-argument instead of throwing', () => {
      for (const nodes of [5, null, {}, 'a', true]) {
        const { report } = build(corner(90, 1), { radius: BEND, nodes });
        expect(report.status).toBe('failed');
        expect(report.error?.code).toBe('model-invalid-argument');
      }
    });
  });

  describe('A8 refusal contract', () => {
    it('edge-short reports the length that passes and a hint naming it', () => {
      const tee = (leg: number): Tuple3[] => [
        [-leg, 0, 0],
        [0, 0, 0],
        [leg, 0, 0],
        [0, leg, 0],
      ];
      const edges = [
        [0, 1],
        [1, 2],
        [1, 3],
      ];
      const short = build(tee(0.1), null, {}, edges);
      expect(short.report.status).toBe('failed');
      expect(reason(short.report)).toBe('edge-short');
      const d = short.report.error?.detail as { length: number; needed: number; edge: number };
      expect(d.needed).toBeGreaterThan(d.length);
      const fixed = build(tee(d.needed * 1.001), null, {}, edges);
      expect(fixed.report.status).toBe('ok');
      expect(short.report.error?.hint).toContain('needed');
    });
  });
});
