import { err, ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { gridOf, integrate, isTrimEligibleGridFailure } from './faces';
import { measureTrimmedFace } from './measure-trimmed';
import { gridInner, gridPiece, measurePlane } from './measure-volume';
import { structureError } from './structure';
import { brepError, type Face, type Shape, type Surface } from './types';
import type { P3 } from './vec';

export interface FaceMeasure {
  readonly area: number;
  /** Signed contribution to the enclosed volume, `(1/3) int p . n dA` along the oriented normal. */
  readonly volume: number;
}

export interface Measure {
  readonly area: number;
  readonly volume: number;
  readonly centroid: P3 | null;
  readonly faces: readonly FaceMeasure[];
  readonly shells: readonly FaceMeasure[];
}

function measureGrid(
  shape: Shape,
  f: number,
  face: Face,
  surface: Surface,
): Result<FaceMeasure, ModelingError> {
  const grid = gridOf(shape, f);
  if (!grid.ok) return grid;
  const g = grid.value;
  const sign = face.reversed ? -1 : 1;
  const piece = gridPiece(surface);
  const area = integrate(
    (u) => integrate((v) => gridInner(surface, u, v)[0], g.v0, g.v1, piece),
    g.u0,
    g.u1,
  );
  const flux = integrate(
    (u) => integrate((v) => gridInner(surface, u, v)[1], g.v0, g.v1, piece),
    g.u0,
    g.u1,
  );
  return ok({ area, volume: (sign * flux) / 3 });
}

/** Closed-form area and divergence-theorem volume per face, summed per shell; no tessellation. */
export function measure(shape: Shape): Result<Measure, ModelingError> {
  const broken = structureError(shape);
  if (broken !== undefined) return err(broken);
  const faces: FaceMeasure[] = [];
  const moments: P3[] = [];
  for (let f = 0; f < shape.faces.length; f++) {
    const face = shape.faces[f] as Face;
    const surface = shape.surfaces[face.surface] as Surface;
    if (surface.kind === 'plane') {
      const trimmed = measureTrimmedFace(shape, f);
      faces.push({ area: trimmed.area, volume: measurePlane(shape, face, surface).volume });
      moments.push(trimmed.moment);
      continue;
    }
    const m = measureGrid(shape, f, face, surface);
    if (m.ok) {
      faces.push(m.value);
      moments.push(measureTrimmedFace(shape, f).moment);
      continue;
    }
    if (isTrimEligibleGridFailure(m.error)) {
      const trimmed = measureTrimmedFace(shape, f);
      faces.push({ area: trimmed.area, volume: trimmed.volume });
      moments.push(trimmed.moment);
      continue;
    }
    return err(brepError('brep-face-unsupported', 'a measurable face', { face: f }));
  }
  const shells = shape.shells.map((s) => {
    let area = 0;
    let volume = 0;
    for (const f of s.faces) {
      area += (faces[f] as FaceMeasure).area;
      volume += (faces[f] as FaceMeasure).volume;
    }
    return { area, volume };
  });
  let area = 0;
  let volume = 0;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let i = 0; i < shape.faces.length; i++) {
    const moment = moments[i] as P3;
    mx += moment[0];
    my += moment[1];
    mz += moment[2];
  }
  for (const s of shells) {
    area += s.area;
    volume += s.volume;
  }
  const centroid: P3 | null = volume === 0 ? null : [mx / volume, my / volume, mz / volume];
  return ok({ area, volume, centroid, faces, shells });
}
