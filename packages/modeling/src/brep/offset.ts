import { ok, type Result } from '@forgeax/engine-types';
import { cos, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { partial } from './section';
import { brepFail, type Surface } from './types';
import { madd3 } from './vec';

/** Relative size below which an offset radius counts as collapsed onto the axis or center. */
const COLLAPSE = 1e-9;

/**
 * The surface every point of `s` reaches when moved `d` along the oriented outward normal
 * (`reversed` faces flip it). The (u, v) parameterization is kept: point `(u, v)` of the result is
 * the offset of point `(u, v)` of the input, so trims transfer unchanged. A radius that shrinks to
 * zero or below, a torus whose tube reaches its axis, and NURBS (E3) are `model-partial`.
 */
export function offsetSurface(
  s: Surface,
  d: number,
  reversed = false,
): Result<Surface, ModelingError> {
  if (!Number.isFinite(d)) return brepFail('brep-bad-argument', 'a finite offset distance', { d });
  const e = reversed ? -d : d;
  switch (s.kind) {
    case 'plane':
      return ok({ kind: 'plane', frame: { ...s.frame, o: madd3(s.frame.o, s.frame.z, e) } });
    case 'cylinder':
    case 'sphere': {
      const radius = s.radius + e;
      if (!(radius > COLLAPSE * s.radius)) {
        return partial('offset-collapse', 'an offset that keeps a positive radius', {
          surface: s.kind,
          radius: s.radius,
          d: e,
        });
      }
      return ok({ ...s, radius });
    }
    case 'cone': {
      // The normal is (cos a) radial - (sin a) axis, so the offset keeps the half-angle and moves the
      // v = 0 circle out by d cos a and down the axis by d sin a; the same (u, v) maps point to point.
      const ca = cos(s.halfAngle);
      const sa = sin(s.halfAngle);
      return ok({
        ...s,
        frame: { ...s.frame, o: madd3(s.frame.o, s.frame.z, -e * sa) },
        radius: s.radius + e * ca,
      });
    }
    case 'torus': {
      const minor = s.minor + e;
      if (!(minor > COLLAPSE * s.minor)) {
        return partial('offset-collapse', 'an offset that keeps a positive tube radius', {
          surface: s.kind,
          minor: s.minor,
          d: e,
        });
      }
      if (!(minor < s.major)) {
        return partial('offset-spindle', 'an offset tube radius below the major radius', {
          surface: s.kind,
          major: s.major,
          minor,
        });
      }
      return ok({ ...s, minor });
    }
    case 'nurbs':
      return partial('offset-nurbs', 'an analytic surface (NURBS offsets are E3)', {
        surface: s.kind,
      });
  }
}
