import { err, ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { gridOf, integrate, isTrimEligibleGridFailure, loopSignedArea } from './faces';
import type { FaceMeasure } from './measure';
import { measureTrimmedVolume } from './measure-trimmed';
import { structureError } from './structure';
import { surfaceDerivatives, surfacePoint } from './surfaces';
import { brepError, type Face, type Shape, type Surface } from './types';
import { cross3, dot3, len3 } from './vec';

export function measurePlane(
  shape: Shape,
  face: Face,
  surface: Surface & { kind: 'plane' },
): FaceMeasure {
  let area = 0;
  for (const l of face.loops)
    area += loopSignedArea(shape, (shape.loops[l] as Shape['loops'][number]).coedges);
  const sign = face.reversed ? -1 : 1;
  return {
    area: Math.abs(area),
    volume: (sign * dot3(surface.frame.o, surface.frame.z) * area) / 3,
  };
}

export function gridInner(surface: Surface, u: number, v: number): [number, number] {
  const { du, dv } = surfaceDerivatives(surface, u, v);
  const n = cross3(du, dv);
  return [len3(n), dot3(surfacePoint(surface, u, v), n)];
}

export function gridPiece(surface: Surface): number | undefined {
  return surface.kind === 'cylinder' || surface.kind === 'cone'
    ? Number.POSITIVE_INFINITY
    : undefined;
}

function gridVolume(
  shape: Shape,
  f: number,
  face: Face,
  surface: Surface,
): Result<number, ModelingError> {
  const grid = gridOf(shape, f);
  if (!grid.ok) return grid;
  const g = grid.value;
  const piece = gridPiece(surface);
  const flux = integrate(
    (u) => integrate((v) => gridInner(surface, u, v)[1], g.v0, g.v1, piece),
    g.u0,
    g.u1,
  );
  return ok(((face.reversed ? -1 : 1) * flux) / 3);
}

/**
 * Shell volumes alone, for callers that need only the orientation sign or the enclosed volume. Each face's
 * volume is computed exactly as `measure` does, but its area and moments are never integrated.
 */
export function measureVolume(
  shape: Shape,
): Result<{ readonly volume: number; readonly shells: readonly number[] }, ModelingError> {
  const broken = structureError(shape);
  if (broken !== undefined) return err(broken);
  const faces: number[] = [];
  for (let f = 0; f < shape.faces.length; f++) {
    const face = shape.faces[f] as Face;
    const surface = shape.surfaces[face.surface] as Surface;
    if (surface.kind === 'plane') {
      faces.push(measurePlane(shape, face, surface).volume);
      continue;
    }
    const v = gridVolume(shape, f, face, surface);
    if (v.ok) {
      faces.push(v.value);
      continue;
    }
    if (isTrimEligibleGridFailure(v.error)) {
      faces.push(measureTrimmedVolume(shape, f));
      continue;
    }
    return err(brepError('brep-face-unsupported', 'a measurable face', { face: f }));
  }
  const shells = shape.shells.map((s) => {
    let volume = 0;
    for (const f of s.faces) volume += faces[f] as number;
    return volume;
  });
  let volume = 0;
  for (const v of shells) volume += v;
  return ok({ volume, shells });
}
