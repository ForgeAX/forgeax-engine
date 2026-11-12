import { type Model, model, type OpReport, type Tuple3 } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-129: bent pipes. Four sessions: a plain 90 degree elbow, a tighter
 * elbow at the minimum bend radius, a 3D double bend and a U with three straight runs. The
 * pipe radius is 0.05 and the centreline bend radius 0.15; x runs along the first leg.
 */
export const C129 = {
  radius: 0.05,
  bendRadius: 0.15,
  tightRadius: 0.0625,
  ringSegments: 16,
} as const;

export interface Skeleton {
  readonly nodes: Tuple3[];
  readonly edges: [number, number][];
}

const chain = (nodes: Tuple3[]): Skeleton => ({
  nodes,
  edges: nodes.slice(1).map((_, i) => [i, i + 1] as [number, number]),
});

export const ELBOW = chain([
  [0, 0, 0],
  [0.5, 0, 0],
  [0.5, 0.5, 0],
]);

export const DOUBLE = chain([
  [0, 0, 0],
  [0.5, 0, 0],
  [0.5, 0.5, 0],
  [0.5, 0.5, 0.5],
]);

export const U_PIPE = chain([
  [-0.4, 0.5, 0],
  [-0.4, 0, 0],
  [0.4, 0, 0],
  [0.4, 0.5, 0],
]);

function checked(report: OpReport): void {
  if (report.status !== 'ok') throw report.error;
}

/** Elbow, tight elbow, 3D double bend, U pipe, box UVs last. */
export function buildPipeBend(session: SessionFactory = () => model()): Model {
  const elbow = session('elbow');
  checked(
    elbow.pipeNetwork({
      ...ELBOW,
      radius: C129.radius,
      ringSegments: C129.ringSegments,
      bend: { radius: C129.bendRadius },
    }),
  );
  const tight = session('tight');
  checked(
    tight.pipeNetwork({
      ...ELBOW,
      radius: C129.radius,
      ringSegments: C129.ringSegments,
      bend: { radius: C129.tightRadius },
    }),
  );
  const double = session('double');
  checked(
    double.pipeNetwork({
      ...DOUBLE,
      radius: C129.radius,
      ringSegments: C129.ringSegments,
      bend: { radius: C129.bendRadius },
    }),
  );
  const u = session('u');
  checked(
    u.pipeNetwork({
      ...U_PIPE,
      radius: C129.radius,
      ringSegments: C129.ringSegments,
      bend: { radius: C129.bendRadius },
    }),
  );
  u.uv.project({ mode: 'box', scale: 0.5 });
  return u;
}

export interface SectionSample {
  readonly session: string;
  readonly stations: number;
  readonly samples: number;
  readonly worstDeviation: number;
  readonly worstRoundness: number;
}

/**
 * Section radius along the first elbow of a chain: at each fraction of the turn the mesh
 * edges crossing the plane normal to the analytic centreline give the distance to it,
 * compared with the pipe radius.
 */
export function sectionAlongBend(
  m: Model,
  path: Skeleton,
  bendRadius: number,
  session: string,
): SectionSample {
  const mesh = m.editMesh;
  const [p0, p1, p2] = [path.nodes[0], path.nodes[1], path.nodes[2]] as [Tuple3, Tuple3, Tuple3];
  const unit = (v: Tuple3): Tuple3 => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const tIn = unit([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
  const tOut = unit([p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]]);
  const c = dot(tIn, tOut);
  const turn = Math.acos(c);
  const tangent = bendRadius * Math.tan(turn / 2);
  const start: Tuple3 = [
    p1[0] - tIn[0] * tangent,
    p1[1] - tIn[1] * tangent,
    p1[2] - tIn[2] * tangent,
  ];
  const inward = unit([tOut[0] - tIn[0] * c, tOut[1] - tIn[1] * c, tOut[2] - tIn[2] * c]);
  const centre: Tuple3 = [
    start[0] + inward[0] * bendRadius,
    start[1] + inward[1] * bendRadius,
    start[2] + inward[2] * bendRadius,
  ];
  let samples = 0;
  let worstDeviation = 0;
  let worstRoundness = 0;
  const fractions = Array.from({ length: 25 }, (_, i) => 0.02 + i * 0.04);
  for (const t of fractions) {
    const psi = turn * t;
    const sin = Math.sin(psi);
    const cos = Math.cos(psi);
    const at: Tuple3 = [
      centre[0] - inward[0] * bendRadius * cos + tIn[0] * bendRadius * sin,
      centre[1] - inward[1] * bendRadius * cos + tIn[1] * bendRadius * sin,
      centre[2] - inward[2] * bendRadius * cos + tIn[2] * bendRadius * sin,
    ];
    const axis: Tuple3 = [
      tIn[0] * cos + inward[0] * sin,
      tIn[1] * cos + inward[1] * sin,
      tIn[2] * cos + inward[2] * sin,
    ];
    const radii: number[] = [];
    const signed = (v: number) => {
      const p = mesh.position(v);
      return dot([p[0] - at[0], p[1] - at[1], p[2] - at[2]], axis);
    };
    for (const e of mesh.edges()) {
      const a = mesh.hVert[e * 2] as number;
      const b = mesh.hVert[e * 2 + 1] as number;
      const da = signed(a);
      const db = signed(b);
      if (!((da <= 0 && db > 0) || (da > 0 && db <= 0))) continue;
      const pa = mesh.position(a);
      const pb = mesh.position(b);
      const k = da / (da - db);
      const rel: Tuple3 = [
        pa[0] + (pb[0] - pa[0]) * k - at[0],
        pa[1] + (pb[1] - pa[1]) * k - at[1],
        pa[2] + (pb[2] - pa[2]) * k - at[2],
      ];
      const along = dot(rel, axis);
      const r = Math.hypot(
        rel[0] - axis[0] * along,
        rel[1] - axis[1] * along,
        rel[2] - axis[2] * along,
      );
      if (r < 1.6 * C129.radius) radii.push(r);
    }
    samples += radii.length;
    const mean = radii.reduce((s, r) => s + r, 0) / Math.max(1, radii.length);
    worstDeviation = Math.max(
      worstDeviation,
      ...radii.map((r) => Math.abs(r - C129.radius) / C129.radius),
    );
    worstRoundness = Math.max(worstRoundness, (Math.max(...radii) - Math.min(...radii)) / mean);
  }
  return { session, stations: fractions.length, samples, worstDeviation, worstRoundness };
}
