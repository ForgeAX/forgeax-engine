import { type Model, model, type OpReport, type Tuple3 } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-121: a pipe manifold built with `pipeNetwork`: a tee, a cross and a
 * 5-way node joined by struts of one radius. Each node type is first built alone, then the
 * three are joined into the connected manifold. x runs along the manifold, y up, z toward
 * the viewer.
 */
export const C121 = {
  radius: 0.05,
  ringSegments: 8,
} as const;

export interface Skeleton {
  readonly nodes: Tuple3[];
  readonly edges: [number, number][];
}

export const TEE: Skeleton = {
  nodes: [
    [0, 0, 0],
    [-0.4, 0, 0],
    [0.4, 0, 0],
    [0, 0.4, 0],
  ],
  edges: [
    [0, 1],
    [0, 2],
    [0, 3],
  ],
};

export const CROSS: Skeleton = {
  nodes: [
    [0, 0, 0],
    [0.4, 0, 0],
    [-0.4, 0, 0],
    [0, 0.4, 0],
    [0, -0.4, 0],
  ],
  edges: [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
  ],
};

export const FIVE: Skeleton = {
  nodes: [
    [0, 0, 0],
    [0.4, 0, 0],
    [-0.4, 0, 0],
    [0, 0.4, 0],
    [0, -0.4, 0],
    [0, 0, 0.4],
  ],
  edges: [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
    [0, 5],
  ],
};

/** Tee at 0, cross at 1, 5-way at 2, in a row 0.6 m apart. */
export const MANIFOLD: Skeleton = {
  nodes: [
    [0, 0, 0],
    [0.6, 0, 0],
    [1.2, 0, 0],
    [-0.4, 0, 0],
    [0, 0.4, 0],
    [0.6, 0.4, 0],
    [0.6, -0.4, 0],
    [1.6, 0, 0],
    [1.2, 0.4, 0],
    [1.2, -0.4, 0],
    [1.2, 0, 0.4],
  ],
  edges: [
    [0, 1],
    [1, 2],
    [0, 3],
    [0, 4],
    [1, 5],
    [1, 6],
    [2, 7],
    [2, 8],
    [2, 9],
    [2, 10],
  ],
};

export const NODE_CENTERS: readonly { readonly name: string; readonly at: Tuple3 }[] = [
  { name: 'tee', at: [0, 0, 0] },
  { name: 'cross', at: [0.6, 0, 0] },
  { name: 'five-way', at: [1.2, 0, 0] },
];

function checked(report: OpReport): void {
  if (report.status !== 'ok') throw report.error;
}

/** The manifold: each node type alone, then the connected network, box UVs last. */
export function buildManifold(session: SessionFactory = () => model()): Model {
  const tee = session('tee');
  checked(tee.pipeNetwork({ ...TEE, radius: C121.radius, ringSegments: C121.ringSegments }));
  const cross = session('cross');
  checked(cross.pipeNetwork({ ...CROSS, radius: C121.radius, ringSegments: C121.ringSegments }));
  const five = session('five-way');
  checked(five.pipeNetwork({ ...FIVE, radius: C121.radius, ringSegments: C121.ringSegments }));
  const m = session('manifold');
  checked(m.pipeNetwork({ ...MANIFOLD, radius: C121.radius, ringSegments: C121.ringSegments }));
  m.uv.project({ mode: 'box', scale: 0.5 });
  return m;
}

export interface SectionRow {
  readonly edge: number;
  readonly at: number;
  readonly samples: number;
  readonly meanRadius: number;
  readonly maxDeviation: number;
}

/** Radii of the mesh's edge crossings with the plane normal to a strut axis, within 1.6 radii. */
function crossings(m: Model, at: Tuple3, axis: Tuple3): number[] {
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
    if (radial < 1.6 * C121.radius) out.push(radial);
  }
  return out;
}

/**
 * The section radius table: at 0.35, 0.5 and 0.65 of each strut's length, the measured radius of the output surface against the requested one.
 */
export function sectionTable(m: Model, net: Skeleton): SectionRow[] {
  const rows: SectionRow[] = [];
  net.edges.forEach(([i, j], edge) => {
    const from = net.nodes[i] as Tuple3;
    const to = net.nodes[j] as Tuple3;
    const span = [0, 1, 2].map((k) => (to[k] as number) - (from[k] as number));
    const len = Math.hypot(...span);
    const axis = span.map((c) => c / len) as Tuple3;
    for (const f of [0.35, 0.5, 0.65]) {
      const s = len * f;
      const at = [0, 1, 2].map((k) => (from[k] as number) + (axis[k] as number) * s) as Tuple3;
      const radii = crossings(m, at, axis);
      const maxDeviation = Math.max(...radii.map((r) => Math.abs(r - C121.radius) / C121.radius));
      const meanRadius = radii.reduce((a, r) => a + r, 0) / radii.length;
      rows.push({ edge, at: s, samples: radii.length, meanRadius, maxDeviation });
    }
  });
  return rows;
}
