import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, hypot3 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { faceCentroid, faceNormal, type Tuple3 } from './geom';
import type { EditMesh } from './mesh';
import type { FaceSelector } from './selectors';
import { SurfaceQuery } from './shrinkwrap';

/** Stamping within `warn` of the direction is safe, up to 90 critical, beyond an undercut. */
export type DraftClass = 'safe' | 'critical' | 'undercut';

export interface DraftFace {
  readonly face: number;
  /** Degrees between the face normal and the direction. */
  readonly angle: number;
  readonly class: DraftClass;
}

export interface DraftOptions {
  /** Pull direction (normalized here). */
  readonly direction: Tuple3;
  /** Faces to check (default all). */
  readonly faces?: FaceSelector;
  /** Degrees from the direction where the critical band starts (default 85). */
  readonly warn?: number;
}

export interface DraftReport {
  readonly faces: readonly DraftFace[];
  readonly critical: readonly number[];
  readonly undercut: readonly number[];
  /**
   * Faces the direction sees (not undercut by angle) whose ray along it hits another checked
   * face: a hidden pocket the die cannot reach (the ray rule).
   */
  readonly shadowed: readonly number[];
}

/** Degrees of rounding a face along the direction may show and still count as critical. */
const ANGLE_TOLERANCE = 1e-5;

/** @internal Classify one face normal against a unit direction. */
export function draftFace(
  face: number,
  normal: Tuple3,
  direction: Tuple3,
  warn: number,
): DraftFace {
  const [a, b] = [normal, direction];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const s = hypot3(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  const angle = (atan2(s, c) * 180) / Math.PI;
  // Faces exactly along the direction (sides of a box) stay critical despite rounding.
  const cls = angle <= warn ? 'safe' : angle <= 90 + ANGLE_TOLERANCE ? 'critical' : 'undercut';
  return { face, angle, class: cls };
}

/** @internal Check `warn` and normalize `direction`. */
export function draftInputs(
  direction: Tuple3,
  warn: number,
): Result<{ direction: Tuple3; warn: number }, ModelingError> {
  const n = hypot3(...direction);
  if (!(n > 0) || !Number.isFinite(n) || !(warn > 0 && warn <= 90)) {
    return err(
      modelingError('model-invalid-argument', 'a non-zero direction and warn in (0, 90] degrees', {
        direction,
        warn,
      }),
    );
  }
  return ok({ direction: direction.map((x) => x / n) as Tuple3, warn });
}

/**
 * Draft against a pull direction: each face's angle to the direction and its
 * class, and the faces a ray along the direction finds hidden behind other faces.
 */
export function draft(
  source: { readonly editMesh: EditMesh; readonly poisoned?: ModelingError | undefined },
  options: DraftOptions,
): Result<DraftReport, ModelingError> {
  if (source.poisoned !== undefined) return err(source.poisoned);
  const inputs = draftInputs(options.direction, options.warn ?? 85);
  if (!inputs.ok) return inputs;
  const { direction, warn } = inputs.value;
  const mesh = source.editMesh;
  const ids = options.faces === undefined ? [...mesh.faces()] : options.faces.evaluate(mesh);
  const query = SurfaceQuery.of(mesh, ids);
  if (!query.ok) return query;
  const faces = ids.map((f) => draftFace(f, faceNormal(mesh, f), direction, warn));
  const lift = 1e-7;
  const shadowed = faces
    .filter((d) => d.class !== 'undercut')
    .filter((d) => {
      const n = faceNormal(mesh, d.face);
      const c = faceCentroid(mesh, d.face);
      const p: Tuple3 = [c[0] + n[0] * lift, c[1] + n[1] * lift, c[2] + n[2] * lift];
      return query.value.occluded(p, direction, d.face);
    })
    .map((d) => d.face);
  return ok({
    faces,
    critical: faces.filter((d) => d.class === 'critical').map((d) => d.face),
    undercut: faces.filter((d) => d.class === 'undercut').map((d) => d.face),
    shadowed,
  });
}
