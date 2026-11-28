import {
  type ColoredTriangles,
  draft,
  type Model,
  model,
  type NurbsSurface,
  nurbs,
  type Point2,
  sel,
  type Tuple3,
} from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { trace } from '../quality-body/body.ts';

/**
 * Three shaping operators on small parts: per-edge bevel widths, a draft turned onto
 * prism walls about a neutral plane, and fairing of a crumpled surface net.
 */
export const SHAPING = {
  /** Saw plate: teeth along x, extruded along z. */
  plate: { teeth: 6, pitch: 0.2, body: 0.2, tooth: 0.1, depth: 0.06 },
  /** Width of the tooth edges at the first and last tooth; the rim width. */
  widths: { first: 0.004, last: 0.034, rim: 0.004 },
  /** Box corner widths for the x, y and z edges. */
  corner: [0.02, 0.05, 0.09] as Tuple3,
  segments: 4,
  /** Mould insert: plate and plus-shaped core, its walls drafted about the plate top. */
  insert: { size: [0.6, 0.06, 0.6] as Tuple3, core: 0.16, angle: 8 },
  /** Trace columns of the hood and the fairing bend weight. */
  hood: { columns: 6, bend: 1e-4 },
} as const;

function outline(): Point2[] {
  const { teeth, pitch, body, tooth } = SHAPING.plate;
  const points: Point2[] = [
    [0, 0],
    [teeth * pitch, 0],
  ];
  for (let k = teeth; k > 0; k--) {
    points.push([k * pitch, body]);
    points.push([(k - 0.5) * pitch, body + tooth]);
  }
  points.push([0, body]);
  return points;
}

/**
 * The saw plate with its tooth edges bevelled from the first width to the last, left to
 * right, and every other edge at the rim width: one `bevel` call with a width list. The
 * tooth entries are slabs along x; an edge takes the first entry that holds it, so each
 * tooth edge takes the first slab that holds both of its faces.
 */
export function buildGradientPlate(session: SessionFactory = () => model()): Model {
  const { teeth, pitch, depth } = SHAPING.plate;
  const { first, last, rim } = SHAPING.widths;
  const m = session('plate');
  m.extrudePolygon({ points: outline(), depth });
  const vertical = sel.edges.parallel('z').minus(sel.facing('-y').toEdges('touching'));
  const slabs = 2 * teeth;
  const width = [
    { edges: sel.edges.perpendicular('z'), width: rim },
    ...Array.from({ length: slabs }, (_, k) => ({
      edges: sel
        .inBox([-1, -1, -1], [((k + 1.5) * pitch) / 2, 1, 1])
        .toEdges('contained')
        .and(vertical),
      width: first + ((last - first) * k) / (slabs - 1),
    })),
    { edges: sel.edges.parallel('z'), width: rim },
  ];
  m.bevel(sel.edges.all(), { width, segments: SHAPING.segments, label: 'saw' });
  return m;
}

/** A box with one width per edge direction, so every corner meets three widths. */
export function buildMixedCorner(session: SessionFactory = () => model()): Model {
  const [a, b, c] = SHAPING.corner;
  const m = session('corner');
  m.box({ size: [0.4, 0.4, 0.4] });
  m.bevel(sel.edges.all(), {
    width: [
      { edges: sel.edges.parallel('x'), width: a },
      { edges: sel.edges.parallel('y'), width: b },
      { edges: sel.edges.parallel('z'), width: c },
    ],
    segments: SHAPING.segments,
    label: 'corner',
  });
  return m;
}

/** The insert's walls: the core sides, which the plate top does not include. */
export const coreWalls = sel.createdBy('core', 'side');

/**
 * A mould insert: a plate with a plus-shaped core extruded from its top. With `drafted`
 * the core walls turn by the draft angle about the plate top, so the core narrows upward
 * and its foot on the plate stays exactly in place.
 */
export function buildInsert(
  session: SessionFactory = () => model(),
  options: { readonly drafted?: boolean } = {},
): Model {
  const { size, core, angle } = SHAPING.insert;
  const m = session(options.drafted === true ? 'drafted' : 'insert');
  m.box({ size, center: [0, size[1] / 2, 0], segments: [3, 1, 3] });
  const third = (size[0] / 6) * 1.01;
  const plus = sel
    .facing('+y')
    .and(
      sel
        .inBox([-third, 0, -size[2]], [third, 1, size[2]])
        .or(sel.inBox([-size[0], 0, -third], [size[0], 1, third])),
    );
  m.extrude(plus, { distance: core, region: 'merged', label: 'core' });
  if (options.drafted === true)
    m.applyDraft(coreWalls, {
      angle,
      direction: [0, 1, 0],
      neutral: sel.facing('+y').minus(sel.extreme('+y')),
    });
  return m;
}

const SAFE: Tuple3 = [0.25, 0.75, 0.35];
const CRITICAL: Tuple3 = [0.95, 0.7, 0.15];
const UNDERCUT: Tuple3 = [0.9, 0.2, 0.2];

/**
 * Draft analysis as colored faces: safe green, critical amber, undercut red, each striped
 * in 2 degree bands of the angle to the pull direction so equal drafts read as one band.
 */
export function draftColors(m: Model, direction: Tuple3 = [0, 1, 0]): ColoredTriangles {
  const report = draft(m, { direction });
  if (!report.ok) throw report.error;
  const mesh = m.editMesh;
  const positions: number[] = [];
  const colors: number[] = [];
  for (const f of report.value.faces) {
    const base = f.class === 'safe' ? SAFE : f.class === 'critical' ? CRITICAL : UNDERCUT;
    const shade = Math.floor(f.angle / 2) % 2 === 0 ? 1 : 0.7;
    const ring = mesh.faceVertices(f.face).map((v) => mesh.position(v));
    for (let i = 1; i + 1 < ring.length; i++)
      for (const p of [ring[0], ring[i], ring[i + 1]] as Tuple3[]) {
        positions.push(...p);
        colors.push(base[0] * shade, base[1] * shade, base[2] * shade, 1);
      }
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    triangles: positions.length / 9,
  };
}

/**
 * The hood columns of the quality-body trace interpolated into one dense net (the trace
 * noise ripples it), and that net faired with its boundary rows kept.
 */
export function hoodNets(): { readonly rippled: NurbsSurface; readonly faired: NurbsSurface } {
  const dense = nurbs.grid(trace().map((row) => row.slice(0, SHAPING.hood.columns)));
  if (!dense.ok) throw dense.error;
  const rippled = dense.value;
  const faired = nurbs.surface.fair(rippled, { fair: { bend: SHAPING.hood.bend } });
  if (!faired.ok) throw faired.error;
  return { rippled, faired: faired.value };
}

export function buildHood(
  session: SessionFactory = () => model(),
  options: { readonly faired?: boolean } = {},
): Model {
  const nets = hoodNets();
  const m = session(options.faired === true ? 'faired' : 'rippled');
  m.surface({
    patches: [{ name: 'hood', surface: options.faired === true ? nets.faired : nets.rippled, flip: true }],
    chord: 0.0005,
    nonPlanar: 'keep',
    spacing: 'even',
  });
  return m;
}
