// One assembly that shows every iso layout together: a holed cylinder, torus, sphere and cone face plus a planar
// plate with a through hole, each a closed solid laid out by quadrangulate in iso mode and set side by side. The
// parts are separate B-reps (booleans do not yet produce holed curved faces), so the assembly is a bench of five.
import { boxWithThroughHole } from '../../src/brep/boolean-hole.ts';
import type { QuadResult } from '../../src/brep/quad.ts';
import { quadrangulate } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { EditMesh } from '../../src/mesh.ts';
import {
  type HoleBoundaryMetrics,
  holeBoundaryMetrics,
  type QuadShapeReport,
  quadShapeReport,
  type ValenceReport,
  valenceReport,
} from './metrics.ts';
import { coneBore, pocketCylinder, sphereBore, torusBore } from './shapes.ts';

const SIZE = 0.25;

interface Bench {
  readonly name: string;
  readonly surface: string;
  readonly at: readonly [number, number, number];
  readonly build: () => ReturnType<typeof pocketCylinder>;
}

const BENCH: readonly Bench[] = [
  { name: 'torus-bore', surface: 'torus', at: [0, 0, 0], build: () => torusBore(-0.25) },
  { name: 'cylinder-pocket', surface: 'cylinder', at: [6.5, 0, 0], build: pocketCylinder },
  {
    name: 'plate-hole',
    surface: 'plane',
    at: [-6.5, 0, 0],
    build: () => boxWithThroughHole({ size: [3, 3, 1], radius: 0.75, label: 'plate' }),
  },
  { name: 'sphere-bore-tilted', surface: 'sphere', at: [0, -6, 0], build: () => sphereBore(0.7) },
  { name: 'cone-bore', surface: 'cone', at: [0, 6.5, -1], build: coneBore },
];

export interface PartRow {
  readonly name: string;
  readonly surface: string;
  readonly quads: number;
  readonly triangles: number;
  readonly openEdges: number;
  readonly nonManifoldEdges: number;
  readonly minSj: number;
  readonly shape: QuadShapeReport;
  readonly valence: ValenceReport;
  readonly boundary: HoleBoundaryMetrics;
}

export interface Assembly {
  readonly rows: readonly PartRow[];
  readonly meshes: readonly EditMesh[];
  readonly shapes: readonly Shape[];
  readonly unified: {
    readonly parts: number;
    readonly quads: number;
    readonly triangles: number;
    readonly minSj: number;
    readonly twistMaxDeg: number;
    readonly aspectMax: number;
    readonly openEdges: number;
    readonly nonManifoldEdges: number;
    readonly rowOnlyMin: number;
    readonly valence: Readonly<Record<string, number>>;
  };
}

function moved(result: QuadResult, at: readonly [number, number, number]): EditMesh {
  const mesh = result.mesh.clone();
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    mesh.setPosition(v, p[0] + at[0], p[1] + at[1], p[2] + at[2]);
  }
  return mesh;
}

/** Quadrangulates every bench part in iso mode (planar faces take the trimmed quad-dominant route). */
export function buildAssembly(): { ok: true; value: Assembly } | { ok: false; error: string } {
  const rows: PartRow[] = [];
  const meshes: EditMesh[] = [];
  const shapes: Shape[] = [];
  for (const part of BENCH) {
    const built = part.build();
    if (!built.ok) return { ok: false, error: `${part.name} did not build` };
    const r = quadrangulate(built.value, {
      size: SIZE,
      trimmed: 'quad-dominant',
      isoQuadric: true,
    });
    if (!r.ok) {
      const reason = (r.error.detail as { reason?: string }).reason ?? r.error.code;
      return { ok: false, error: `${part.name}: ${reason}` };
    }
    const rep = r.value.report;
    rows.push({
      name: part.name,
      surface: part.surface,
      quads: rep.quads,
      triangles: rep.triangles,
      openEdges: rep.openEdges,
      nonManifoldEdges: rep.nonManifoldEdges,
      minSj: rep.scaledJacobian.min,
      shape: quadShapeReport(r.value),
      valence: valenceReport(r.value),
      boundary: holeBoundaryMetrics(built.value, r.value),
    });
    meshes.push(moved(r.value, part.at));
    shapes.push(built.value);
  }
  const valence: Record<string, number> = {};
  for (const row of rows)
    for (const [k, n] of Object.entries(row.valence.histogram)) valence[k] = (valence[k] ?? 0) + n;
  return {
    ok: true,
    value: {
      rows,
      meshes,
      shapes,
      unified: {
        parts: rows.length,
        quads: rows.reduce((n, r) => n + r.quads, 0),
        triangles: rows.reduce((n, r) => n + r.triangles, 0),
        minSj: Math.min(...rows.map((r) => r.minSj)),
        twistMaxDeg: Math.max(...rows.map((r) => r.shape.twistMaxDeg)),
        aspectMax: Math.max(...rows.map((r) => r.shape.aspectMax)),
        openEdges: rows.reduce((n, r) => n + r.openEdges, 0),
        nonManifoldEdges: rows.reduce((n, r) => n + r.nonManifoldEdges, 0),
        rowOnlyMin: Math.min(...rows.map((r) => r.boundary.rowOnly)),
        valence,
      },
    },
  };
}
