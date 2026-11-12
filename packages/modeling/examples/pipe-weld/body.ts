import { type Model, model, type OpReport, type Tuple3 } from '@forgeax/engine-modeling';
import { sectionDeviations, spine, spineDeviations } from '../../src/__tests__/weld-measure.ts';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-128: hard-welded pipe joints. Four sessions: the soft-joint tee for
 * comparison, the welded tee (run 0.1, branch 0.07, fillet 0.01), a welded manifold (run with
 * two opposed branches) and a welded frame whose corner is a mitered bend with a branch off
 * the long leg. x runs along the main pipe, y up.
 */
export const C128 = {
  run: 0.1,
  branch: 0.07,
  fillet: 0.01,
  ringSegments: 16,
  filletSegments: 4,
} as const;

export interface Skeleton {
  readonly nodes: Tuple3[];
  readonly edges: [number, number][];
  readonly edgeRadius: number[];
}

export const TEE: Skeleton = {
  nodes: [
    [-1, 0, 0],
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  edges: [
    [0, 1],
    [1, 2],
    [1, 3],
  ],
  edgeRadius: [C128.run, C128.run, C128.branch],
};

export const MANIFOLD: Skeleton = {
  nodes: [...TEE.nodes, [0, -1, 0]],
  edges: [...TEE.edges, [1, 4]],
  edgeRadius: [C128.run, C128.run, C128.branch, C128.branch],
};

/** Corner at node 1 (mitered), a branch off the long leg at node 3. */
export const FRAME: Skeleton = {
  nodes: [
    [0, 0, 0],
    [0, 1, 0],
    [1.2, 1, 0],
    [0.6, 1, 0],
    [0.6, 0.2, 0],
  ],
  edges: [
    [0, 1],
    [1, 3],
    [3, 2],
    [3, 4],
  ],
  edgeRadius: [C128.run, C128.run, C128.run, C128.branch],
};

function checked(report: OpReport): void {
  if (report.status !== 'ok') throw report.error;
}

/** Soft tee, welded tee, welded manifold, welded frame, box UVs last. */
export function buildPipeWeld(session: SessionFactory = () => model()): Model {
  const soft = session('soft');
  checked(soft.pipeNetwork({ ...TEE, radius: C128.run, ringSegments: 8 }));
  const tee = session('tee');
  checked(
    tee.pipeNetwork({
      ...TEE,
      radius: C128.run,
      ringSegments: C128.ringSegments,
      weld: { radius: C128.fillet, segments: C128.filletSegments },
    }),
  );
  const manifold = session('manifold');
  checked(
    manifold.pipeNetwork({
      ...MANIFOLD,
      radius: C128.run,
      ringSegments: C128.ringSegments,
      weld: { radius: C128.fillet, segments: C128.filletSegments },
    }),
  );
  const frame = session('frame');
  checked(
    frame.pipeNetwork({
      ...FRAME,
      radius: C128.run,
      ringSegments: C128.ringSegments,
      weld: { radius: C128.fillet, segments: C128.filletSegments },
    }),
  );
  frame.uv.project({ mode: 'box', scale: 0.5 });
  return frame;
}

export interface FilletSample {
  readonly session: string;
  readonly samples: number;
  readonly worstDeviation: number;
}

/**
 * Fillet radius of the welded tee measured in its z = 0 symmetry plane: each section point of
 * the weld faces within two radii of the crotch arc is compared with the distance to the
 * rolling-ball centre (tube apothem plus the fillet radius).
 */
export function filletDeviation(m: Model): FilletSample {
  const mesh = m.editMesh;
  const apothem = Math.cos(Math.PI / C128.ringSegments);
  const devs: number[] = [];
  for (const f of mesh.faces()) {
    if (!String(mesh.labelNames[mesh.fLabel[f] as number]).startsWith('weld:')) continue;
    const loop = mesh.faceVertices(f);
    for (let i = 0; i < loop.length; i++) {
      const p = mesh.position(loop[i] as number);
      const q = mesh.position(loop[(i + 1) % loop.length] as number);
      if (!((p[2] <= 0 && q[2] > 0) || (p[2] > 0 && q[2] <= 0))) continue;
      const t = p[2] / (p[2] - q[2]);
      const x = p[0] + (q[0] - p[0]) * t;
      const y = p[1] + (q[1] - p[1]) * t;
      if (y < C128.run * apothem - 1e-9 || Math.abs(x) < 1e-9) continue;
      const d = Math.hypot(
        x - Math.sign(x) * (C128.branch * apothem + C128.fillet),
        y - (C128.run * apothem + C128.fillet),
      );
      if (d < 2 * C128.fillet) devs.push(Math.abs(d - C128.fillet) / C128.fillet);
    }
  }
  return { session: 'tee', samples: devs.length, worstDeviation: Math.max(0, ...devs) };
}

export interface FilletCurve {
  readonly spineSamples: number;
  readonly worstSpineDeviation: number;
  readonly sectionStations: number;
  readonly worstSectionDeviation: number;
  readonly sagFloor: number;
}

/**
 * Fillet radius of the welded tee over the whole intersection curve: weld vertices against
 * the analytic rolling-ball spine, and circle fits in planes normal to it at 32 stations.
 */
export function filletCurve(m: Model): FilletCurve {
  const apothem = Math.cos(Math.PI / C128.ringSegments);
  const centres = spine(
    { origin: [0, 0, 0], axis: [1, 0, 0], radius: C128.run * apothem },
    { origin: [0, 0, 0], axis: [0, 1, 0], radius: C128.branch * apothem },
    C128.fillet,
  );
  const spineDev = spineDeviations(m, centres, C128.fillet);
  const sections = sectionDeviations(m, centres, C128.fillet).map(Math.abs);
  return {
    spineSamples: spineDev.length,
    worstSpineDeviation: Math.max(0, ...spineDev),
    sectionStations: sections.length,
    worstSectionDeviation: Math.max(0, ...sections),
    sagFloor: (C128.run * (1 - apothem)) / C128.fillet,
  };
}
