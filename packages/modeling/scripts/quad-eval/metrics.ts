// Element and topology metrics for the quad evaluator.
// Definitions follow design-L4-quad-eval.md section "Metric definitions".

import {
  boundsOf,
  cross,
  dot,
  type EvalMesh,
  length,
  normalize,
  sub,
  type Topology,
  topologyOf,
  type Vec3,
} from './mesh.ts';

const REPORT_IDS = 32;

export interface ElementInfo {
  readonly face: number;
  readonly sides: number;
  readonly degenerate: boolean;
  /** Scaled Jacobian of the element: min corner value, 0 when degenerate. */
  readonly sJ: number;
  /** Max over min edge length; NaN when degenerate. */
  readonly aspect: number;
  /** Unit Newell normal; the zero vector when degenerate. */
  readonly normal: Vec3;
  /** Per-corner scaled Jacobian values in loop order; empty when degenerate. */
  readonly corners: readonly number[];
}

export interface Summary {
  readonly min: number;
  readonly p10: number;
  readonly mean: number;
  readonly max: number;
  readonly n: number;
}

export interface Hist {
  readonly valence: number;
  readonly count: number;
}

export interface Evaluation {
  readonly diag: number;
  readonly finite: boolean;
  readonly counts: {
    vertices: number;
    edges: number;
    faces: number;
    triangles: number;
    quads: number;
    ngons: number;
  };
  readonly topology: Topology;
  readonly elements: readonly ElementInfo[];
  readonly degenerate: { count: number; ids: readonly number[] };
  readonly inverted: { count: number; ids: readonly number[] };
  readonly scaledJacobian: Summary;
  readonly aspect: { p50: number | null; p90: number | null; max: number | null; n: number };
  readonly valence: {
    ideal: number;
    interior: readonly Hist[];
    boundary: readonly Hist[];
    singularities: { count: number; deficit: number };
  };
  readonly euler: {
    chi: number;
    closed: boolean;
    deficitSum: number;
    expected: number | null;
    ok: boolean;
  };
}

export function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.floor(q * (sorted.length - 1))] as number;
}

export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    min: sorted[0] ?? 0,
    p10: n === 0 ? 0 : quantile(sorted, 0.1),
    mean: n === 0 ? 0 : sum / n,
    max: sorted[n - 1] ?? 0,
    n,
  };
}

export function elementInfo(mesh: EvalMesh, diag: number): ElementInfo[] {
  return mesh.faces.map((loop, face) => {
    const pts = loop.map((v) => mesh.positions[v] as [number, number, number]);
    const n = pts.length;
    const repeated = new Set(loop).size !== n;
    let newell: Vec3 = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const c = cross(pts[i] as [number, number, number], pts[(i + 1) % n] as [number, number, number]);
      newell = [newell[0] + c[0], newell[1] + c[1], newell[2] + c[2]];
    }
    const edges = pts.map((p, i) =>
      length(sub(pts[(i + 1) % n] as [number, number, number], p as [number, number, number])),
    );
    const shortEdge = edges.some((e) => e <= 1e-12 * diag);
    const tinyArea = length(newell) <= 2e-12 * diag * diag;
    if (repeated || shortEdge || tinyArea)
      return {
        face,
        sides: n,
        degenerate: true,
        sJ: 0,
        aspect: Number.NaN,
        normal: [0, 0, 0],
        corners: [],
      };
    const nhat = normalize(newell);
    const corners = pts.map((p, i) => {
      const a = normalize(
        sub(pts[(i + 1) % n] as [number, number, number], p as [number, number, number]),
      );
      const b = normalize(
        sub(pts[(i - 1 + n) % n] as [number, number, number], p as [number, number, number]),
      );
      return dot(cross(a, b), nhat);
    });
    return {
      face,
      sides: n,
      degenerate: false,
      sJ: Math.min(...corners),
      aspect: Math.max(...edges) / Math.min(...edges),
      normal: nhat,
      corners,
    };
  });
}

function histogram(values: readonly number[]): Hist[] {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0] - b[0]).map(([valence, count]) => ({ valence, count }));
}

export function evaluate(mesh: EvalMesh): Evaluation {
  const finite = mesh.positions.every((p) => p.every((c) => Number.isFinite(c)));
  const { diag } = boundsOf(mesh.positions);
  const topology = topologyOf(mesh);
  const elements = elementInfo(mesh, diag);
  const sides = elements.map((e) => e.sides);
  const triangles = sides.filter((s) => s === 3).length;
  const quads = sides.filter((s) => s === 4).length;
  const faces = mesh.faces.length;

  const degenerateIds = elements.filter((e) => e.degenerate).map((e) => e.face);
  const invertedIds = elements.filter((e) => !e.degenerate && e.sJ <= 0).map((e) => e.face);
  const aspects = elements
    .filter((e) => !e.degenerate)
    .map((e) => e.aspect)
    .sort((a, b) => a - b);

  const ideal = quads * 2 >= faces ? 4 : 6;
  const interior = topology.interiorValence;
  const deficit = interior.reduce((s, v) => s + (ideal - v), 0);
  const homogeneous = triangles === faces || quads === faces;
  const expected = topology.closed && homogeneous ? ideal * topology.chi : null;
  const eulerOk = expected === null ? true : deficit === expected;

  return {
    diag,
    finite,
    counts: {
      vertices: topology.vertices,
      edges: topology.edges,
      faces,
      triangles,
      quads,
      ngons: faces - triangles - quads,
    },
    topology,
    elements,
    degenerate: { count: degenerateIds.length, ids: degenerateIds.slice(0, REPORT_IDS) },
    inverted: { count: invertedIds.length, ids: invertedIds.slice(0, REPORT_IDS) },
    scaledJacobian: summarize(elements.filter((e) => e.sides <= 4).map((e) => e.sJ)),
    aspect: {
      p50: aspects.length === 0 ? null : quantile(aspects, 0.5),
      p90: aspects.length === 0 ? null : quantile(aspects, 0.9),
      max: aspects.length === 0 ? null : (aspects[aspects.length - 1] as number),
      n: aspects.length,
    },
    valence: {
      ideal,
      interior: histogram(interior),
      boundary: histogram(topology.boundaryValence),
      singularities: {
        count: interior.filter((v) => v !== ideal).length,
        deficit,
      },
    },
    euler: {
      chi: topology.chi,
      closed: topology.closed,
      deficitSum: deficit,
      expected,
      ok: eulerOk,
    },
  };
}
