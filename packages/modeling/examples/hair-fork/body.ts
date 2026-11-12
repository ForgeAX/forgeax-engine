import { type Model, model, type OpReport, type Tuple3 } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-127: a hair strand that forks and tapers, built with pipeNetwork radii
 * per node and per edge. Four sessions on one skeleton family: the equal-radius fork (the
 * B26-1 result), the 1:2 fork (`edgeRadius`), the tapering fork (`nodeRadius`: radius shrinks
 * linearly along each strand) and a two-level tapering lock. x runs across, y up the strand.
 */
export const C127 = {
  trunk: 0.04,
  twig: 0.02,
  tip: 0.015,
  ringSegments: 8,
} as const;

export interface Skeleton {
  readonly nodes: Tuple3[];
  readonly edges: [number, number][];
}

/** Root, fork node and two tips. */
export const FORK: Skeleton = {
  nodes: [
    [0, 0, 0],
    [0, 0.5, 0],
    [-0.3, 0.9, 0],
    [0.3, 0.9, 0],
  ],
  edges: [
    [0, 1],
    [1, 2],
    [1, 3],
  ],
};

/** The fork whose left branch forks again. */
export const LOCK: Skeleton = {
  nodes: [
    [0, 0, 0],
    [0, 0.45, 0],
    [-0.25, 0.8, 0],
    [0.3, 0.9, 0],
    [-0.45, 1.15, 0],
    [-0.1, 1.2, 0],
  ],
  edges: [
    [0, 1],
    [1, 2],
    [1, 3],
    [2, 4],
    [2, 5],
  ],
};

export const FORK_NODE_RADIUS = [C127.trunk, C127.trunk, C127.tip, C127.tip];
export const LOCK_NODE_RADIUS = [C127.trunk, C127.trunk, 0.028, C127.tip, 0.01, 0.01];
export const FORK_EDGE_RADIUS = [C127.trunk, C127.twig, C127.twig];

function checked(report: OpReport): void {
  if (report.status !== 'ok') throw report.error;
}

/** Equal fork, 1:2 fork, tapering fork and tapering lock, box UVs last. */
export function buildHairFork(session: SessionFactory = () => model()): Model {
  const equal = session('equal');
  checked(equal.pipeNetwork({ ...FORK, radius: C127.trunk, ringSegments: C127.ringSegments }));
  const fork = session('fork');
  checked(
    fork.pipeNetwork({
      ...FORK,
      radius: C127.trunk,
      edgeRadius: FORK_EDGE_RADIUS,
      ringSegments: C127.ringSegments,
    }),
  );
  const taper = session('taper');
  checked(
    taper.pipeNetwork({
      ...FORK,
      radius: C127.trunk,
      nodeRadius: FORK_NODE_RADIUS,
      ringSegments: C127.ringSegments,
    }),
  );
  const lock = session('lock');
  checked(
    lock.pipeNetwork({
      ...LOCK,
      radius: C127.trunk,
      nodeRadius: LOCK_NODE_RADIUS,
      ringSegments: C127.ringSegments,
    }),
  );
  lock.uv.project({ mode: 'box', scale: 0.5 });
  return lock;
}

export interface SectionRow {
  readonly edge: number;
  readonly at: number;
  readonly samples: number;
  readonly expected: number;
  readonly meanRadius: number;
  readonly maxDeviation: number;
}

function crossings(m: Model, at: Tuple3, axis: Tuple3, reach: number): number[] {
  const mesh = m.editMesh;
  const out: number[] = [];
  const signed = (v: number) => {
    const p = mesh.position(v);
    return (p[0] - at[0]) * axis[0] + (p[1] - at[1]) * axis[1] + (p[2] - at[2]) * axis[2];
  };
  for (const e of mesh.edges()) {
    const a = mesh.hVert[e * 2] as number;
    const b = mesh.hVert[e * 2 + 1] as number;
    const da = signed(a);
    const db = signed(b);
    if (!((da <= 0 && db > 0) || (da > 0 && db <= 0))) continue;
    const t = da / (da - db);
    const pa = mesh.position(a);
    const pb = mesh.position(b);
    const p = [0, 1, 2].map((k) => (pa[k] as number) + ((pb[k] as number) - (pa[k] as number)) * t);
    const rel = [0, 1, 2].map((k) => (p[k] as number) - (at[k] as number));
    const along =
      (rel[0] as number) * axis[0] + (rel[1] as number) * axis[1] + (rel[2] as number) * axis[2];
    const radial = Math.hypot(...rel.map((c, k) => c - along * (axis[k] as number)));
    if (radial < reach) out.push(radial);
  }
  return out;
}

/**
 * Section radius table: at the stations the kernel reports (both ends and the middle of each
 * strut's straight part), the radius measured on the output surface here against the radius
 * interpolated linearly between the strut's two ring radii.
 */
export function sectionTable(m: Model, net: Skeleton): SectionRow[] {
  const info = m.journal
    .flatMap((entry) => entry.diagnostics ?? [])
    .find((d) => d.message.startsWith('section radius'));
  const stations = (info?.detail?.stations ?? []) as readonly {
    edge: number;
    at: number;
    expected: number;
  }[];
  return stations.map(({ edge, at: s, expected }) => {
    const [i, j] = net.edges[edge] as [number, number];
    const from = net.nodes[i] as Tuple3;
    const to = net.nodes[j] as Tuple3;
    const span = [0, 1, 2].map((k) => (to[k] as number) - (from[k] as number));
    const len = Math.hypot(...span);
    const axis = span.map((c) => c / len) as Tuple3;
    const at = [0, 1, 2].map((k) => (from[k] as number) + (axis[k] as number) * s) as Tuple3;
    const radii = crossings(m, at, axis, 1.6 * expected);
    const maxDeviation = Math.max(...radii.map((r) => Math.abs(r - expected) / expected));
    const meanRadius = radii.reduce((a, r) => a + r, 0) / radii.length;
    return { edge, at: s, samples: radii.length, expected, meanRadius, maxDeviation };
  });
}
