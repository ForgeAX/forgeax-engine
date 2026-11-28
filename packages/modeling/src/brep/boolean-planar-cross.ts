import { ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../arrays';
import type { ModelingError } from '../errors';
import { ShapeAssembler } from './assembler';
import { Copier } from './copier';
import { type CarriedHoles, carriedHoles, clearOfFaces, holdsCircle } from './planar-cross-circles';
import { cutHolesIntoPolygons } from './planar-cross-holes';
import { type KeptCell, mergeCoplanarCells } from './planar-cross-merge';
import {
  componentCount,
  containingFaces,
  interiorPoint,
  locateByRay,
  type RayFace,
} from './planar-cross-nonconvex';
import { sectionPolygon } from './planar-section';
import type { Face, Shape, Surface } from './types';
import { brepFail } from './types';
import { cross3, dist3, dot3, len3, type P3, sub3, unit3 } from './vec';

interface FacePolygon {
  readonly index: number;
  readonly face: Face;
  readonly surface: Surface & { readonly kind: 'plane' };
  readonly points: readonly P3[];
  readonly holes: readonly (readonly P3[])[];
}

function refuse(reason: string, ids: Record<string, unknown> = {}): Result<never, ModelingError> {
  return brepFail('brep-ssi-unsupported', 'a closed planar crossing boolean', {
    reason: `planar-cross-${reason}`,
    ...ids,
  });
}

function outward(face: Face, surface: Surface & { readonly kind: 'plane' }): P3 {
  return face.reversed
    ? [-surface.frame.z[0], -surface.frame.z[1], -surface.frame.z[2]]
    : surface.frame.z;
}

export function hasOnlyPlanarFaces(solids: readonly [Shape, Shape]): boolean {
  return solids.every((shape) =>
    shape.faces.every((face) => shape.surfaces[face.surface]?.kind === 'plane'),
  );
}

function loopPoints(shape: Shape, loopIndex: number, face: number): Result<P3[], ModelingError> {
  const loop = shape.loops[loopIndex];
  if (loop === undefined || loop.coedges.length < 3) return refuse('face-loop', { face });
  const points: P3[] = [];
  for (const ci of loop.coedges) {
    const coedge = shape.coedges[ci];
    const edge = coedge === undefined ? undefined : shape.edges[coedge.edge];
    const curve = edge === undefined || edge.curve < 0 ? undefined : shape.curves[edge.curve];
    if (coedge === undefined || edge === undefined || curve?.kind !== 'line')
      return refuse('curved-boundary', { face });
    const vertex = shape.vertices[coedge.reversed ? edge.v1 : edge.v0];
    if (vertex === undefined) return refuse('boundary-vertex', { face });
    points.push(vertex.p);
  }
  return ok(points);
}

function polygons(shape: Shape, carry: CarriedHoles | null): Result<FacePolygon[], ModelingError> {
  const out: FacePolygon[] = [];
  for (let fi = 0; fi < shape.faces.length; fi++) {
    if (carry?.lateralFaces.has(fi)) continue;
    const face = shape.faces[fi] as Face;
    const surface = shape.surfaces[face.surface];
    if (surface?.kind !== 'plane') return refuse('non-planar-input', { face: fi });
    const [outerIndex, ...innerIndices] = face.loops;
    if (outerIndex === undefined || !shape.loops[outerIndex]?.outer)
      return refuse('face-loop', { face: fi });
    const points = loopPoints(shape, outerIndex, fi);
    if (!points.ok) return points;
    const holes: P3[][] = [];
    for (const inner of innerIndices) {
      if (carry?.holeLoops.has(inner)) continue;
      if (shape.loops[inner]?.outer !== false) return refuse('face-loop', { face: fi });
      const ring = loopPoints(shape, inner, fi);
      if (!ring.ok) return ring;
      holes.push(ring.value);
    }
    out.push({ index: fi, face, surface, points: points.value, holes });
  }
  return ok(out);
}

function convex(shape: Shape, faces: readonly FacePolygon[], tol: number): boolean {
  for (const face of faces) {
    if (face.holes.length > 0) return false;
    const n = outward(face.face, face.surface);
    for (const v of shape.vertices) {
      if (dot3(sub3(v.p, face.surface.frame.o), n) > tol) return false;
    }
    for (let i = 0; i < face.points.length; i++) {
      const a = face.points[i] as P3;
      const b = face.points[(i + 1) % face.points.length] as P3;
      const c = face.points[(i + 2) % face.points.length] as P3;
      const turn = dot3(cross3(sub3(b, a), sub3(c, b)), face.surface.frame.z);
      if (turn < -tol * Math.max(1, dist3(a, b), dist3(b, c))) return false;
    }
  }
  return true;
}

function splitAgainst(
  polygon: readonly P3[],
  faces: readonly FacePolygon[],
  tol: number,
): Result<readonly P3[][], ModelingError> {
  let pieces: readonly P3[][] = [polygon.slice()];
  const planes: (Surface & { readonly kind: 'plane' })[] = [];
  for (const face of faces) {
    const known = planes.some(
      (plane) =>
        Math.abs(dot3(sub3(face.surface.frame.o, plane.frame.o), plane.frame.z)) <= tol &&
        1 - Math.abs(dot3(face.surface.frame.z, plane.frame.z)) <= tol * tol,
    );
    if (!known) planes.push(face.surface);
  }
  for (const plane of planes) {
    const next: P3[][] = [];
    for (const piece of pieces) {
      const split = sectionPolygon(piece, plane, tol);
      if (!split.ok) return split;
      if (split.value === null) next.push(piece);
      else pushAll(next, split.value);
    }
    pieces = next;
  }
  return ok(pieces);
}

type Location = 'inside' | 'outside' | 'on';

function locate(point: P3, faces: readonly FacePolygon[], tol: number): Location {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const face of faces) {
    const d = dot3(sub3(point, face.surface.frame.o), outward(face.face, face.surface));
    maximum = Math.max(maximum, d);
  }
  if (maximum > tol) return 'outside';
  return maximum >= -tol ? 'on' : 'inside';
}

function centroid(points: readonly P3[]): P3 {
  const sum: [number, number, number] = [0, 0, 0];
  for (const p of points) {
    sum[0] += p[0];
    sum[1] += p[1];
    sum[2] += p[2];
  }
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

function nonDegenerate(points: readonly P3[], tol: number): boolean {
  let area: P3 = [0, 0, 0];
  const origin = points[0] as P3;
  for (let i = 1; i + 1 < points.length; i++) {
    const wedge = cross3(sub3(points[i] as P3, origin), sub3(points[i + 1] as P3, origin));
    area = [area[0] + wedge[0], area[1] + wedge[1], area[2] + wedge[2]];
  }
  return len3(area) > tol * tol;
}

/**
 * Orientation of a coplanar piece against the face of the other solid it lies on: true when both
 * outward normals agree. Null when no face holds the piece, or the faces there disagree.
 */
function sameOrientation(
  polygon: readonly P3[],
  probe: P3,
  source: FacePolygon,
  others: readonly RayFace[],
  tol: number,
): boolean | null {
  const hosts = containingFaces(polygon, probe, others, tol);
  if (hosts.length === 0) return null;
  const own = outward(source.face, source.surface);
  const votes = new Set(hosts.map((host) => dot3(own, host.outward) > 0));
  return votes.size === 1 ? (votes.has(true) as boolean) : null;
}

/**
 * Regularized rule for a piece on the other solid's boundary. Both solids carry the piece, so only
 * the first solid's copy can be kept: union and intersection keep it when the outward normals agree
 * (the surface bounds both and remains a boundary) and drop both copies when they oppose (the
 * contact is interior to the union, absent from the intersection); difference keeps the first
 * solid's copy exactly when they oppose, since it subtracts the complement's flipped boundary.
 */
function keepOnBoundary(
  op: 'union' | 'difference' | 'intersect',
  side: 0 | 1,
  same: boolean,
): boolean {
  if (side === 1) return false;
  return op === 'difference' ? !same : same;
}

/** True when an undirected edge bounds more than two result faces: solids that meet only along it. */
function overusedEdge(rings: readonly (readonly (readonly number[])[])[]): boolean {
  const uses = new Map<string, number>();
  for (const face of rings) {
    for (const ring of face) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i] as number;
        const b = ring[(i + 1) % ring.length] as number;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        const count = (uses.get(key) ?? 0) + 1;
        if (count > 2) return true;
        uses.set(key, count);
      }
    }
  }
  return false;
}

type Op = 'union' | 'difference' | 'intersect';
type Carry = readonly [CarriedHoles | null, CarriedHoles | null];

export function booleanPlanarCross(
  solids: readonly [Shape, Shape],
  tol: number,
  op: Op,
): Result<Shape, ModelingError> {
  const first = polygons(solids[0], null);
  if (!first.ok) return first;
  const second = polygons(solids[1], null);
  if (!second.ok) return second;
  return crossPolygons(solids, [first.value, second.value], [null, null], tol, op);
}

/**
 * The planar crossing for one solid with drilled through holes (circle cap loops and cylinder walls)
 * and one all-planar solid that stays clear of every hole. Hole walls pass through whole and each circle
 * loop stays a circle loop of the cap region that contains it. Null when the pair is outside that scope.
 */
export function booleanPlanarCrossCarryingHoles(
  solids: readonly [Shape, Shape],
  tol: number,
  op: Op,
): Result<Shape, ModelingError> | null {
  const curved = solids.map((shape) =>
    shape.faces.some((face) => shape.surfaces[face.surface]?.kind !== 'plane'),
  );
  if (curved[0] === curved[1]) return null;
  const holed: 0 | 1 = curved[0] ? 0 : 1;
  const carried = carriedHoles(solids[holed]);
  if (carried === null || carried.laterals.length === 0) return null;
  const plain = polygons(solids[1 - holed] as Shape, null);
  if (!plain.ok) return null;
  const rings = plain.value.flatMap((f) => [f.points, ...f.holes]);
  if (!carried.laterals.every((lateral) => clearOfFaces(lateral, rings, tol))) return null;
  const own = polygons(solids[holed], carried);
  if (!own.ok) return null;
  const faces: [FacePolygon[], FacePolygon[]] =
    holed === 0 ? [own.value, plain.value] : [plain.value, own.value];
  const carry: Carry = holed === 0 ? [carried, null] : [null, carried];
  return crossPolygons(solids, faces, carry, tol, op);
}

function keepFor(op: Op, side: 0 | 1, where: 'inside' | 'outside'): boolean {
  if (op === 'union') return where === 'outside';
  if (op === 'intersect') return where === 'inside';
  return side === 0 ? where === 'outside' : where === 'inside';
}

function crossPolygons(
  solids: readonly [Shape, Shape],
  faces: readonly [FacePolygon[], FacePolygon[]],
  carry: Carry,
  tol: number,
  op: Op,
): Result<Shape, ModelingError> {
  const isConvex = [convex(solids[0], faces[0], tol), convex(solids[1], faces[1], tol)] as const;
  const rayFaces = faces.map((side) =>
    side.map((f) => ({
      points: f.points,
      holes: f.holes,
      origin: f.surface.frame.o,
      outward: outward(f.face, f.surface),
    })),
  ) as [RayFace[], RayFace[]];

  let diagonal = 0;
  for (const shape of solids) {
    for (const vertex of shape.vertices) diagonal = Math.max(diagonal, len3(vertex.p));
  }
  const built = ShapeAssembler.create(Math.max(1, diagonal), {
    tol,
    maxTol: Math.max(solids[0].maxTol, solids[1].maxTol, tol),
  });
  if (!built.ok) return built;
  const asm = built.value;
  const copiedSurfaces: [Map<number, number>, Map<number, number>] = [new Map(), new Map()];
  const edges = new Map<string, number>();
  const vertices = new Map<number, P3>();
  const resultFaces: number[] = [];

  const idFor = (p: P3): number => {
    const id = asm.vertex(p);
    if (!vertices.has(id)) vertices.set(id, p);
    return id;
  };
  const edgeBetween = (va: number, vb: number): number => {
    const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
    const known = edges.get(key);
    if (known !== undefined) return known;
    const pa = vertices.get(va) as P3;
    const pb = vertices.get(vb) as P3;
    const curve = asm.curve({ kind: 'line', o: pa, d: unit3(sub3(pb, pa)) });
    const edge = asm.edge(curve, 0, dist3(pa, pb));
    edges.set(key, edge);
    return edge;
  };
  const ringLoop = (
    surfaceId: number,
    ring: readonly number[],
    outer: boolean,
  ): Result<number, ModelingError> =>
    asm.loop(
      surfaceId,
      ring.map((id, i) => ({ edge: edgeBetween(id, ring[(i + 1) % ring.length] as number) })),
      outer,
    );

  const kept: KeptCell[] = [];
  const groups: { readonly side: 0 | 1; readonly source: FacePolygon }[] = [];

  for (const side of [0, 1] as const) {
    const other = (1 - side) as 0 | 1;
    for (let fi = 0; fi < faces[side].length; fi++) {
      const sourceFace = faces[side][fi] as FacePolygon;
      const parts =
        sourceFace.holes.length === 0
          ? [sourceFace.points.slice()]
          : cutHolesIntoPolygons(
              sourceFace.points,
              sourceFace.holes,
              sourceFace.surface.frame.z,
              tol,
            );
      if (parts === null) return refuse('hole-bridge', { side, face: fi });
      const pieces: P3[][] = [];
      for (const part of parts) {
        const split = splitAgainst(part, faces[other], tol);
        if (!split.ok) return split;
        pushAll(pieces, split.value);
      }
      const group = groups.length;
      groups.push({ side, source: sourceFace });
      for (const polygon of pieces) {
        if (!nonDegenerate(polygon, tol)) return refuse('area-below-tolerance', { side, face: fi });
        const probe = isConvex[other]
          ? centroid(polygon)
          : interiorPoint(polygon, sourceFace.surface.frame.z);
        if (probe === null) return refuse('area-below-tolerance', { side, face: fi });
        const where = isConvex[other]
          ? locate(probe, faces[other], tol)
          : locateByRay(probe, rayFaces[other], tol);
        if (where === 'ambiguous') return refuse('ray-ambiguous', { side, face: fi });
        let keep: boolean;
        if (where === 'on') {
          const same = sameOrientation(polygon, probe, sourceFace, rayFaces[other], tol);
          if (same === null) return refuse('coplanar-or-tolerance-contact', { side, face: fi });
          keep = keepOnBoundary(op, side, same);
        } else keep = keepFor(op, side, where);
        if (keep) kept.push({ group, ring: polygon.map(idFor) });
      }
    }
  }
  const regions = mergeCoplanarCells({
    cells: kept,
    position: (id) => vertices.get(id) as P3,
    normalOf: (group) => (groups[group] as (typeof groups)[number]).source.surface.frame.z,
  });
  if (regions.length === 0) return refuse('empty-result', { operation: op });
  const rings = regions.map((region) => [region.outer, ...region.holes]);
  if (overusedEdge(rings)) return refuse('non-manifold-contact', { operation: op });
  if (componentCount(rings) !== 1) return refuse('multi-component-result', { operation: op });
  const copiers = [new Copier(solids[0], asm), new Copier(solids[1], asm)] as const;
  const circleLoops = new Map<number, number[]>();
  for (const side of [0, 1] as const) {
    const carried = carry[side];
    if (carried === null) continue;
    const other = (1 - side) as 0 | 1;
    const placed = carried.holes.map((hole) => {
      // clearOfFaces kept every bounded chord of the other solid off this circle, so each merged
      // region of the cap holds the whole circle or none of it; `touching` means that failed.
      let home: number | null = null;
      for (let r = 0; r < regions.length; r++) {
        const region = regions[r] as (typeof regions)[number];
        const { side: s, source } = groups[region.group] as (typeof groups)[number];
        if (s !== side || source.index !== hole.face) continue;
        const ringPoints = [region.outer, ...region.holes].map((ring) =>
          ring.map((id) => vertices.get(id) as P3),
        );
        const where = holdsCircle(ringPoints, hole, source.surface.frame.z, tol);
        if (where === 'touching') return undefined;
        if (where === 'inside') home = r;
      }
      return home;
    });
    if (placed.includes(undefined)) return refuse('circle-hole-contact', { side });
    for (let li = 0; li < carried.laterals.length; li++) {
      const lateral = carried.laterals[li] as (typeof carried.laterals)[number];
      const where = isConvex[other]
        ? locate(lateral.probe, faces[other], tol)
        : locateByRay(lateral.probe, rayFaces[other], tol);
      if (where !== 'inside' && where !== 'outside')
        return refuse('circle-hole-contact', { side, face: lateral.face });
      const keepWall = keepFor(op, side, where);
      const homes = carried.holes.flatMap((hole, h) => (hole.lateral === li ? [placed[h]] : []));
      if (homes.some((home) => (home !== null) !== keepWall))
        return refuse('circle-hole-inconsistent', { side, face: lateral.face });
      if (!keepWall) continue;
      const wall = solids[side].faces[lateral.face] as Face;
      const surfaceId = copiers[side].surface(wall.surface);
      const loops: number[] = [];
      for (const l of wall.loops) {
        const loop = asm.loop(surfaceId, copiers[side].loopEdges(l), true);
        if (!loop.ok)
          return refuse('loop-assembly', { face: lateral.face, cause: loop.error.detail });
        loops.push(loop.value);
      }
      const reversed = side === 1 && op === 'difference' ? !wall.reversed : wall.reversed;
      resultFaces.push(asm.face(surfaceId, loops, reversed, wall.label, wall.role));
    }
    carried.holes.forEach((hole, h) => {
      const home = placed[h];
      if (home !== null && home !== undefined)
        circleLoops.set(home, [...(circleLoops.get(home) ?? []), hole.loop]);
    });
  }
  for (let r = 0; r < regions.length; r++) {
    const region = regions[r] as (typeof regions)[number];
    const { side, source } = groups[region.group] as (typeof groups)[number];
    let surfaceId = copiedSurfaces[side].get(source.face.surface);
    if (surfaceId === undefined) {
      surfaceId = asm.surface(source.surface);
      copiedSurfaces[side].set(source.face.surface, surfaceId);
    }
    const outer = ringLoop(surfaceId, region.outer, true);
    if (!outer.ok)
      return refuse('loop-assembly', { group: region.group, cause: outer.error.detail });
    const loops = [outer.value];
    for (const hole of region.holes) {
      const inner = ringLoop(surfaceId, hole, false);
      if (!inner.ok)
        return refuse('loop-assembly', { group: region.group, cause: inner.error.detail });
      loops.push(inner.value);
    }
    for (const circle of circleLoops.get(r) ?? []) {
      const inner = asm.loop(surfaceId, copiers[side].loopEdges(circle), false);
      if (!inner.ok)
        return refuse('loop-assembly', { group: region.group, cause: inner.error.detail });
      loops.push(inner.value);
    }
    const reversed =
      side === 1 && op === 'difference' ? !source.face.reversed : source.face.reversed;
    resultFaces.push(asm.face(surfaceId, loops, reversed, source.face.label, source.face.role));
  }
  asm.shell(resultFaces);
  return asm.finish();
}
