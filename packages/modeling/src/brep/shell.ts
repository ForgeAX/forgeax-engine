import { err, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { type RevolveOptions, revolve } from './build';
import { brepError, type Shape } from './types';
import type { P2 } from './vec';

export interface RevolveShellOptions extends Omit<RevolveOptions, 'profile'> {
  /**
   * Outer meridian `[radius, z]`: starts on the axis (radius 0), every interior point has radius
   * > 0, and it ends on an open rim (radius > 0). Counter-clockwise in (radius, z) when closed by
   * the axis, so the solid lies on the left of each segment.
   */
  readonly profile: readonly P2[];
  /** Wall thickness, measured inward along the normal of every meridian segment. */
  readonly thickness: number;
}

function bad(why: string, ids?: Record<string, unknown>) {
  return err(brepError('brep-bad-argument', why, ids));
}

/**
 * Hollow solid of revolution: the outer meridian minus its mitred inward offset, closed by the rim
 * face. Each corner is the intersection of the two offset segments; the first offset segment is
 * cut where it meets the axis. The result is one revolve of the open profile
 * `outer..rim, inner reversed` and therefore inherits revolve's validation.
 */
export function revolveShell(options: RevolveShellOptions): Result<Shape, ModelingError> {
  const { profile, thickness, ...rest } = options;
  const t = thickness;
  if (!(Number.isFinite(t) && t > 0)) return bad('a positive finite thickness');
  const n = profile.length - 1;
  if (n < 2 || profile.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
    return bad('a meridian of at least 3 finite points');
  }
  const p0 = profile[0] as P2;
  const pn = profile[n] as P2;
  if (p0[0] !== 0 || pn[0] <= 0) {
    return bad('a meridian starting on the axis and ending on a rim with radius > 0');
  }
  for (let i = 1; i < n; i++) {
    if ((profile[i] as P2)[0] <= 0) return bad('interior meridian points with radius > 0');
  }

  const dir: P2[] = [];
  const left: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = profile[i] as P2;
    const b = profile[i + 1] as P2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 0)) return bad('nonzero meridian segments');
    dir.push([dx / len, dy / len]);
    left.push([-dy / len, dx / len]);
  }

  let twiceArea = pn[0] * p0[1] - p0[0] * pn[1];
  for (let i = 0; i < n; i++) {
    const a = profile[i] as P2;
    const b = profile[i + 1] as P2;
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  if (!(twiceArea > 0)) {
    return bad('a meridian counter-clockwise in (radius, z) when closed by the axis');
  }

  // Inner start: the offset of the first segment, cut at radius 0.
  const d0 = dir[0] as P2;
  const l0 = left[0] as P2;
  const s0 = -(p0[0] + t * l0[0]) / d0[0];
  const inner0: P2 = [0, p0[1] + t * l0[1] + s0 * d0[1]];

  const corners: P2[] = [];
  for (let i = 1; i < n; i++) {
    const P = profile[i] as P2;
    const dp = dir[i - 1] as P2;
    const dn = dir[i] as P2;
    const lp = left[i - 1] as P2;
    const ln = left[i] as P2;
    const cx = t * (ln[0] - lp[0]);
    const cy = t * (ln[1] - lp[1]);
    const cross = dp[0] * dn[1] - dp[1] * dn[0];
    const s = Math.abs(cross) > 1e-12 ? (cx * dn[1] - cy * dn[0]) / cross : 0;
    const corner: P2 = [P[0] + t * lp[0] + s * dp[0], P[1] + t * lp[1] + s * dp[1]];
    if (!(corner[0] > 0)) return bad('a thickness that keeps the wall off the axis');
    corners.push(corner);
  }

  const ln = left[n - 1] as P2;
  const rim: P2 = [pn[0] + t * ln[0], pn[1] + t * ln[1]];
  if (!(rim[0] > 0)) return bad('a thickness that keeps the rim off the axis');

  const open: P2[] = [...profile, rim];
  for (let i = corners.length - 1; i >= 0; i--) open.push(corners[i] as P2);
  open.push(inner0);
  return revolve({ ...rest, profile: open, label: rest.label ?? 'shell' });
}
