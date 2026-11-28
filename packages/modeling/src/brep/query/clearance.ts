import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../../arrays';
import type { ModelingError } from '../../errors';
import { brepError, type Shape } from '../types';
import type { P3 } from '../vec';
import {
  type Contact,
  type Foot,
  type SearchOptions,
  shapeDistance,
  shapePieces,
  signedDistance,
} from './distance';
import { closedShells } from './inside';
import type { Piece } from './pieces';

/**
 * `clear`: the solids are apart by `gap > touch`. `touching`: the surfaces meet within the shapes'
 * tolerance and no sampled boundary point of either lies inside the other. `interfering`: a sampled
 * boundary point of one lies strictly inside the other, `depth` deep. `contained`: one solid lies
 * wholly inside the other with `gap` between the surfaces.
 */
export type ClearanceKind = 'clear' | 'touching' | 'interfering' | 'contained';

export interface Clearance {
  readonly kind: ClearanceKind;
  /** Minimum surface-to-surface distance (witness points `pointA`, `pointB`); 0 when the surfaces meet. */
  readonly gap: number;
  /** `gap` lies in `[gap - errorBound, gap]`. */
  readonly errorBound: number;
  readonly pointA: P3;
  readonly pointB: P3;
  readonly footA: Foot;
  readonly footB: Foot;
  /**
   * Lower bound of how far the sampled boundary reaches into the other solid (0 unless `interfering`);
   * a certificate that the overlap is at least this deep, not the minimum translation distance.
   */
  readonly depth: number;
  /** The sampled boundary point that attains `depth`, with the shape whose surface it lies on. */
  readonly deepest: { readonly point: P3; readonly of: 'a' | 'b' } | undefined;
  readonly samples: number;
}

export interface ClearanceOptions extends SearchOptions {
  /** Piece-split levels used to sample each boundary (default 3). */
  readonly sampleDepth?: number;
}

const unresolved = (reason: string, expected: string): Result<never, ModelingError> =>
  err(brepError('brep-tol-exceeded', expected, { reason }));

/** Points on the surface of `shape`: the valid centres of every piece after `depth` splits. */
function boundarySamples(shape: Shape, depth: number): Result<P3[], ModelingError> {
  const roots = shapePieces(shape);
  if (!roots.ok) return roots;
  const out: P3[] = [];
  let level: readonly Piece[] = roots.value;
  for (let d = 0; ; d++) {
    for (const piece of level) if (piece.valid) out.push(piece.point);
    if (d === depth) break;
    const next: Piece[] = [];
    for (const piece of level) pushAll(next, piece.split() ?? []);
    if (next.length === 0) break;
    level = next;
  }
  return ok(out);
}

interface Reach {
  readonly depth: number;
  readonly point: P3 | undefined;
  readonly samples: number;
  readonly failed: number;
}

/** The deepest sampled point of `of` that lies strictly inside `into` (a certified depth), if any. */
function reachInto(
  of: Shape,
  into: Shape,
  margin: number,
  depth: number,
): Result<Reach, ModelingError> {
  const pts = boundarySamples(of, depth);
  if (!pts.ok) return pts;
  let best = 0;
  let at: P3 | undefined;
  let failed = 0;
  for (const p of pts.value) {
    const s = signedDistance(into, p);
    if (!s.ok) {
      failed++;
      continue;
    }
    const certified = -s.value.value - s.value.errorBound;
    if (certified > margin && certified > best) {
      best = certified;
      at = p;
    }
  }
  return ok({ depth: best, point: at, samples: pts.value.length, failed });
}

/**
 * Minimum distance between two closed solids with witness points, and whether they are clear, touching,
 * interfering or nested. The distance comes from the pair search; touching versus interfering is decided
 * with signed distance at sampled boundary points. Fails closed (`model-partial`, reason
 * `clearance-unresolved`) when the answer is "touching" but some sample could not be signed, or a
 * solid is open.
 */
export function clearanceBetween(
  a: Shape,
  b: Shape,
  options?: ClearanceOptions,
): Result<Clearance, ModelingError> {
  if (!closedShells(a) || !closedShells(b))
    return unresolved('clearance-open-shape', 'two closed solids');
  const d = shapeDistance(a, b, options);
  if (!d.ok) return d;
  const v = d.value;
  const base = {
    errorBound: v.errorBound,
    pointA: v.pointA,
    pointB: v.pointB,
    footA: v.footA,
    footB: v.footB,
  };
  const gapOf = (c: Contact): number =>
    c.kind === 'separate' ? v.distance : c.kind === 'contact' ? c.gap : c.clearance;
  const gap = gapOf(v.contact);
  if (v.contact.kind === 'separate')
    return ok({ ...base, kind: 'clear', gap, depth: 0, deepest: undefined, samples: 0 });
  if (v.contact.kind === 'containment')
    return ok({ ...base, kind: 'contained', gap, depth: 0, deepest: undefined, samples: 0 });

  const level = options?.sampleDepth ?? 3;
  const margin = a.tol + b.tol;
  const ab = reachInto(a, b, margin, level);
  if (!ab.ok) return ab;
  const ba = reachInto(b, a, margin, level);
  if (!ba.ok) return ba;
  const samples = ab.value.samples + ba.value.samples;
  const deeper = ab.value.depth >= ba.value.depth ? 'a' : 'b';
  const best = deeper === 'a' ? ab.value : ba.value;
  if (best.point !== undefined)
    return ok({
      ...base,
      kind: 'interfering',
      gap: 0,
      depth: best.depth,
      deepest: { point: best.point, of: deeper },
      samples,
    });
  if (ab.value.failed + ba.value.failed > 0)
    return unresolved('clearance-unresolved', 'every boundary sample signed');
  return ok({ ...base, kind: 'touching', gap, depth: 0, deepest: undefined, samples });
}
