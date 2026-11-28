import { cos, sin } from '../dmath';
import { pcurvePoint, pcurveTangent } from './curves';
import { integrate } from './faces';
import { surfaceDerivatives, surfacePoint } from './surfaces';
import type { Coedge, Face, Shape, Surface } from './types';
import { cross3, dot3, len3, type P3 } from './vec';

export interface TrimmedFaceMeasure {
  readonly area: number;
  readonly volume: number;
  /** Signed first volume moment about the world coordinate planes. */
  readonly moment: P3;
}

type Field = 'area' | 'volume' | 0 | 1 | 2;

function areaIntegral(surface: Surface, u: number, v: number): number {
  if (surface.kind === 'plane') {
    const { du, dv } = surfaceDerivatives(surface, u, v);
    return u * len3(cross3(du, dv));
  }
  if (surface.kind === 'cylinder') return surface.radius * u;
  if (surface.kind === 'cone') {
    return u * (surface.radius + v * sin(surface.halfAngle));
  }
  if (surface.kind === 'sphere') return surface.radius * surface.radius * u * cos(v);
  if (surface.kind === 'torus') {
    return u * surface.minor * (surface.major + surface.minor * cos(v));
  }
  return integrate(
    (s) => {
      const { du, dv } = surfaceDerivatives(surface, s, v);
      return len3(cross3(du, dv));
    },
    0,
    u,
  );
}

/**
 * A plane's parameters are lengths and its integrands are polynomials of degree at most four in them, so one
 * Gauss piece is exact however long the span is; trig-bearing quadrics keep the default angular pieces.
 */
function lengthPiece(surface: Surface): number | undefined {
  return surface.kind === 'plane' ? Number.POSITIVE_INFINITY : undefined;
}

/**
 * Piece size for a boundary integral along `pcurve`. A straight trim on a plane is linear in a length
 * parameter. A straight trim on a cylinder or cone with no angular change (`d[0] === 0`) runs along the axial
 * length, where the surface integrands are polynomial; the angle stays fixed, so one piece is exact.
 */
function boundaryPiece(surface: Surface, pcurve: Coedge['pcurve']): number | undefined {
  if (pcurve.kind !== 'line') return undefined;
  if (surface.kind === 'plane') return Number.POSITIVE_INFINITY;
  if ((surface.kind === 'cylinder' || surface.kind === 'cone') && pcurve.d[0] === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return undefined;
}

function fluxIntegral(surface: Surface, u: number, v: number): number {
  return integrate(
    (s) => {
      const { du, dv } = surfaceDerivatives(surface, s, v);
      return dot3(surfacePoint(surface, s, v), cross3(du, dv));
    },
    0,
    u,
    lengthPiece(surface),
  );
}

function potential(surface: Surface, u: number, v: number, field: Field): number {
  if (field === 'area') return areaIntegral(surface, u, v);
  if (field === 'volume') return fluxIntegral(surface, u, v) / 3;
  return integrate(
    (s) => {
      const { du, dv } = surfaceDerivatives(surface, s, v);
      const point = surfacePoint(surface, s, v);
      return (point[field] * point[field] * cross3(du, dv)[field]) / 2;
    },
    0,
    u,
    lengthPiece(surface),
  );
}

function boundaryIntegral(
  shape: Shape,
  surface: Surface,
  coedgeIndex: number,
  field: Field,
): number {
  const coedge = shape.coedges[coedgeIndex] as Coedge;
  const edge = shape.edges[coedge.edge];
  if (edge === undefined || edge.curve < 0) return 0;
  const ta = coedge.reversed ? edge.t1 : edge.t0;
  const tb = coedge.reversed ? edge.t0 : edge.t1;
  return integrate(
    (t) => {
      const [u, v] = pcurvePoint(coedge.pcurve, t);
      const tangent = pcurveTangent(coedge.pcurve, t);
      return potential(surface, u, v, field) * tangent[1];
    },
    ta,
    tb,
    boundaryPiece(surface, coedge.pcurve),
  );
}

/** Oriented volume of a trimmed face: the volume boundary integral alone, bit-equal to `measureTrimmedFace(...).volume`. */
export function measureTrimmedVolume(shape: Shape, faceIndex: number): number {
  const face = shape.faces[faceIndex] as Face;
  const surface = shape.surfaces[face.surface] as Surface;
  let volume = 0;
  for (const loopIndex of face.loops) {
    const loop = shape.loops[loopIndex];
    if (loop === undefined) continue;
    for (const coedgeIndex of loop.coedges)
      volume += boundaryIntegral(shape, surface, coedgeIndex, 'volume');
  }
  return (face.reversed ? -1 : 1) * volume;
}

/** Green-boundary integrals on the face's oriented loops, including every hole and degenerate trim. */
export function measureTrimmedFace(shape: Shape, faceIndex: number): TrimmedFaceMeasure {
  const face = shape.faces[faceIndex] as Face;
  const surface = shape.surfaces[face.surface] as Surface;
  let area = 0;
  let volume = 0;
  const moment: [number, number, number] = [0, 0, 0];
  for (const loopIndex of face.loops) {
    const loop = shape.loops[loopIndex];
    if (loop === undefined) continue;
    for (const coedgeIndex of loop.coedges) {
      area += boundaryIntegral(shape, surface, coedgeIndex, 'area');
      volume += boundaryIntegral(shape, surface, coedgeIndex, 'volume');
      for (let axis = 0; axis < 3; axis++) {
        moment[axis] =
          (moment[axis] as number) +
          boundaryIntegral(shape, surface, coedgeIndex, axis as 0 | 1 | 2);
      }
    }
  }
  const sign = face.reversed ? -1 : 1;
  return {
    area: Math.abs(area),
    volume: sign * volume,
    moment: [sign * moment[0], sign * moment[1], sign * moment[2]],
  };
}
