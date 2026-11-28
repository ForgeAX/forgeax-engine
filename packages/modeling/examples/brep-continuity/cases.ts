import { pcurvePoint } from '../../src/brep/curves.ts';
import { splitFace } from '../../src/brep/edit.ts';
import { pipeElbow } from '../../src/brep/elbow.ts';
import { filletBox } from '../../src/brep/fillet-box.ts';
import { filletCylinder } from '../../src/brep/fillet-cylinder.ts';
import { compact, draftOf } from '../../src/brep/rebuild.ts';
import { transformShape } from '../../src/brep/transform.ts';
import type { Coedge, Edge, Frame, Shape, Surface } from '../../src/brep/types.ts';
import type { P3 } from '../../src/brep/vec.ts';
import { must } from '../brep-heal/damage.ts';
import { buildHousing, buildPlate } from '../brep-heal/parts.ts';

export interface ContinuityCase {
  readonly name: string;
  readonly caption: string;
  readonly shape: Shape;
  /** More parts rendered and measured with `shape`, each on its own (an assembly is not fused). */
  readonly extra?: readonly Shape[];
}

function faceIndices(shape: Shape, kind: Surface['kind']): number[] {
  const out: number[] = [];
  shape.faces.forEach((f, i) => {
    if ((shape.surfaces[f.surface] as Surface).kind === kind) out.push(i);
  });
  return out;
}

/** The (u, v) box of a face: its coedge pcurves sampled at both ends. */
function uvRange(shape: Shape, face: number): { u: [number, number]; v: [number, number] } {
  const u: [number, number] = [Infinity, -Infinity];
  const v: [number, number] = [Infinity, -Infinity];
  for (const l of shape.faces[face]?.loops ?? [])
    for (const c of shape.loops[l]?.coedges ?? []) {
      const ce = shape.coedges[c] as Coedge;
      const e = shape.edges[ce.edge] as Edge;
      for (const t of [e.t0, e.t1]) {
        const [pu, pv] = pcurvePoint(ce.pcurve, t);
        u[0] = Math.min(u[0], pu);
        u[1] = Math.max(u[1], pu);
        v[0] = Math.min(v[0], pv);
        v[1] = Math.max(v[1], pv);
      }
    }
  return { u, v };
}

/** Cut every face of `kind` through the middle of its `axis` range: same surface on both sides, so a G2 edge. */
export function splitMiddle(shape: Shape, kind: Surface['kind'], axis: 'u' | 'v'): Shape {
  let out = shape;
  for (const label of faceIndices(shape, kind).map(
    (i) => (shape.faces[i] as { label: string }).label,
  )) {
    const face = out.faces.findIndex((f) => f.label === label);
    const r = uvRange(out, face)[axis];
    out = must(splitFace(out, face, { axis, at: 0.5 * (r[0] + r[1]) })).shape;
  }
  return out;
}

function withSurface(shape: Shape, face: number, move: (s: Surface) => Surface): Shape {
  const d = draftOf(shape);
  const index = (d.faces[face] as { surface: number }).surface;
  d.surfaces[index] = move(d.surfaces[index] as Surface);
  return must(compact(d)).shape;
}

/** Translate one face's surface: the faces no longer meet along its edges. */
export function translateFace(shape: Shape, face: number, by: P3): Shape {
  return withSurface(shape, face, (s) => {
    if (s.kind === 'nurbs') throw new Error('translateFace: NURBS surface');
    const o: P3 = [s.frame.o[0] + by[0], s.frame.o[1] + by[1], s.frame.o[2] + by[2]];
    return { ...s, frame: { ...s.frame, o } } as Surface;
  });
}

/** Tilt a planar face about the x-parallel line through `pivot` by `angle` radians: a kink along that line. */
export function tiltPlane(shape: Shape, face: number, pivot: P3, angle: number): Shape {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rot = (p: P3): P3 => [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]];
  return withSurface(shape, face, (surface) => {
    if (surface.kind !== 'plane') throw new Error('tiltPlane: not a plane');
    const f = surface.frame;
    const rel: P3 = [f.o[0] - pivot[0], f.o[1] - pivot[1], f.o[2] - pivot[2]];
    const r = rot(rel);
    const frame: Frame = {
      o: [pivot[0] + r[0], pivot[1] + r[1], pivot[2] + r[2]],
      x: rot(f.x),
      y: rot(f.y),
      z: rot(f.z),
    };
    return { kind: 'plane', frame };
  });
}

const BOX = { size: [10, 8, 6] as P3, radius: 1.5 };
const ELBOW = { bend: 12, outer: 3, inner: 2, leg: 8 };

export function filletedBox(): Shape {
  return must(filletBox(BOX));
}

export function pipeElbowShape(): Shape {
  return must(pipeElbow(ELBOW));
}

const SCREWS: readonly P3[] = [
  [8, 8, 18],
  [72, 8, 18],
  [8, 42, 18],
  [72, 42, 18],
];

/** The housing body with four rounded-rim standoffs standing on its screw bosses. */
export function housingAssembly(): ContinuityCase {
  const standoff = must(filletCylinder({ radius: 6, height: 14, fillet: 1.2 }));
  const identity = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as const;
  return {
    name: 'housing-assembly',
    caption: 'housing creases G0, the four standoff rims G1',
    shape: buildHousing(),
    extra: SCREWS.map((t) => must(transformShape(standoff, { rot: identity, t }))),
  };
}

export function allCases(): ContinuityCase[] {
  const box = filletedBox();
  const elbow = pipeElbowShape();
  const top = box.faces.findIndex((f) => f.label === 'filleted-box.p2+');
  return [
    {
      name: 'filleted-box',
      caption: 'flat-to-round joins are tangent, not curvature continuous',
      shape: box,
    },
    {
      name: 'filleted-box-split',
      caption: 'bands cut in half: same surface on both sides, G2',
      shape: splitMiddle(box, 'cylinder', 'v'),
    },
    {
      name: 'pipe-elbow',
      caption: 'straight to bend is tangent (G1), end caps are creases (G0)',
      shape: elbow,
    },
    {
      name: 'pipe-elbow-split',
      caption: 'bend and legs cut in half: G2 along the cuts',
      shape: splitMiddle(splitMiddle(elbow, 'torus', 'u'), 'cylinder', 'v'),
    },
    {
      name: 'fillet-cylinder',
      caption: 'rounded rim: disk to torus and torus to side are G1',
      shape: must(filletCylinder({ radius: 6, height: 10, fillet: 1.2 })),
    },
    {
      name: 'bracket',
      caption: 'raw bracket: creases, two coplanar joins at G2',
      shape: buildPlate(),
    },
    {
      name: 'kinked-box',
      caption: 'top tilted 0.04 rad: one join a crease, three open',
      shape: tiltPlane(box, top, [0, 2.5, 3], 0.04),
    },
    {
      name: 'opened-box',
      caption: 'one corner moved 0.05: its three joins open',
      shape: translateFace(
        box,
        box.faces.findIndex((f) => f.label === 'filleted-box.c111'),
        [0.05, 0.05, 0.05],
      ),
    },
    housingAssembly(),
  ];
}
