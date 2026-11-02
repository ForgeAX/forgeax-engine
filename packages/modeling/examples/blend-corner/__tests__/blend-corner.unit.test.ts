import { fileURLToPath } from 'node:url';
import { type Model, type NurbsSurface, nurbs, type Tuple3 } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildCorner, buildRoll, buildRunOut, buildSharp, C120, surfaces, tailCorner } from '../body';

/**
 * Case C-120 gate: the mech-gt calf plate's knee as built, rolled whole-edge, run out
 * at the T-tail corner, and a setback corner of three G2 rolls. Every build is one
 * watertight disk; only the documented density and fairness costs remain.
 */
const findings = (m: Model) =>
  m
    .validate({ surfaceQuality: true })
    .issues.filter((i) => i.severity !== 'info')
    .map((i) => `${i.code}:${i.detail.check ?? ''}@${i.detail.subject ?? ''}`);

/** Euler characteristic and boundary loops: a watertight single-sheet build is a disk (1, 1). */
function topology(m: Model): { euler: number; loops: number } {
  const mesh = m.editMesh;
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    while (parent.get(r) !== r) r = parent.get(r) as number;
    return r;
  };
  for (const e of mesh.edges()) {
    if (!mesh.isBoundaryEdge(e)) continue;
    const [a, b] = mesh.edgeVertices(e);
    for (const v of [a, b]) if (!parent.has(v)) parent.set(v, v);
    parent.set(find(a), find(b));
  }
  const loops = new Set([...parent.keys()].map(find)).size;
  return { euler: mesh.vertexCount - mesh.edgeCount + mesh.faceCount, loops };
}

const distance = (a: Tuple3, b: Tuple3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Per side of `s`, the farthest control point of that side from `p`. */
function sideReach(s: NurbsSurface, p: Tuple3): Record<'u0' | 'u1' | 'v0' | 'v1', number> {
  const reach = (pts: readonly Tuple3[]) => Math.max(...pts.map((q) => distance(q, p)));
  return {
    u0: reach(s.points[0] as Tuple3[]),
    u1: reach(s.points.at(-1) as Tuple3[]),
    v0: reach(s.points.map((row) => row[0] as Tuple3)),
    v1: reach(s.points.map((row) => row.at(-1) as Tuple3)),
  };
}

const KNEE_GAP = ['flank:trim0|knee:v0', 'upper:trim0|knee:v1'].map(
  (s) => `surface-quality:surface-continuity@${s}`,
);
const CORNER_QUADS = ['corner-0', 'corner-1', 'corner-2'];

describe('C-120 blend run-out and setback corner on the mech-gt T-tail', () => {
  it('(a) the plate as built: a watertight disk, sharp knee and edge on their G0 lines', { timeout: 120_000 }, () => {
    const m = buildSharp();
    expect(m.poisoned).toBeUndefined();
    expect(findings(m)).toEqual([]);
    expect(topology(m)).toEqual({ euler: 1, loops: 1 });
  });

  it('(b) a whole-edge roll leaves an open roll end at the T-tail corner', { timeout: 120_000 }, () => {
    const m = buildRoll();
    expect(m.poisoned).toBeUndefined();
    // The roll's contacts turn at the held slanted end: its fair fit stops 33 to 44 um off
    // the trims, above its 5 um gap, and both contacts report it.
    expect(findings(m)).toEqual(KNEE_GAP);
    expect(topology(m)).toEqual({ euler: 1, loops: 1 });
    // The roll's tail end (u1) is a full section between its contacts, standing open at the shut.
    const knee = surfaces(m).get('knee') as NurbsSurface;
    const end = knee.points.at(-1) as Tuple3[];
    expect(distance(end[0] as Tuple3, end.at(-1) as Tuple3)).toBeGreaterThan(0.002);
    expect(sideReach(knee, tailCorner()).u1).toBeGreaterThan(0.001);
  });

  it('(c) the run-out collapses the roll onto the T-tail corner', { timeout: 120_000 }, () => {
    const m = buildRunOut();
    expect(m.poisoned).toBeUndefined();
    // The faces keep their 7 x 5 nets under the trims, and the band's along-edge net is exempt;
    // the held end leaves the same reported gap.
    expect(findings(m)).toEqual(KNEE_GAP);
    expect(topology(m)).toEqual({ euler: 1, loops: 1 });
    const reach = sideReach(surfaces(m).get('knee') as NurbsSurface, tailCorner());
    expect(reach.u1).toBeLessThanOrEqual(1e-6);
  });

  it('(d) the setback corner closes three G2 rolls within 0.1 degree', { timeout: 120_000 }, () => {
    const m = buildCorner();
    expect(m.poisoned).toBeUndefined();
    expect(findings(m)).toEqual([
      ...CORNER_QUADS.map((q) => `surface-quality:surface-density@${q}`),
      ...CORNER_QUADS.flatMap((q) => [`surface-quality:surface-fairness@${q}`, `surface-quality:surface-fairness@${q}`]),
    ]);
    expect(topology(m)).toEqual({ euler: 1, loops: 1 });
    const info = m.journal.at(-1)?.diagnostics?.find((d) => d.severity === 'info' && 'blends' in (d.detail ?? {}));
    const corner = (info?.detail as { blends: { setback: number; kink: number; residual: Record<string, number> }[] })
      .blends[0];
    expect(corner?.setback).toBe(C120.setback);
    expect(corner?.residual.sideAngle).toBeLessThanOrEqual(0.1);
    expect(corner?.residual.spokeAngle).toBeLessThanOrEqual(0.1);
    expect(corner?.residual.normalSpread).toBeLessThan(90);
    // The quads share one normal at the center O (their (0, 0) corner).
    const centre = CORNER_QUADS.map((q) => {
      const d = nurbs.surfaceDerivatives(surfaces(m).get(q) as NurbsSurface, 0, 0, 1);
      const a = (d[1] as Tuple3[])[0] as Tuple3;
      const b = (d[0] as Tuple3[])[1] as Tuple3;
      const n: Tuple3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const l = Math.hypot(...n);
      return n.map((x) => x / l) as Tuple3;
    });
    for (const a of centre)
      for (const b of centre)
        expect((Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI).toBeLessThanOrEqual(0.1);
    expect(corner?.residual.gap).toBeLessThanOrEqual(1e-6);
    expect(corner?.kink).toBeLessThanOrEqual(0.01);
  });

  it('the Dawn case maps every session to its source lines', { timeout: 120_000 }, () => {
    const recording = recordingSessions();
    buildSharp(recording.session);
    buildRoll(recording.session);
    buildRunOut(recording.session);
    buildCorner(recording.session);
    const steps = attachSourceLines(recording.steps, fileURLToPath(new URL('../body.ts', import.meta.url)));
    expect(steps.map((s) => `${s.session}.${s.entry.op}`)).toEqual([
      'sharp.featureLine',
      'sharp.featureLine',
      'sharp.surface',
      'roll.featureLine',
      'roll.featureLine',
      'roll.surface',
      'run-out.featureLine',
      'run-out.featureLine',
      'run-out.surface',
      'corner.surface',
    ]);
  });
});
