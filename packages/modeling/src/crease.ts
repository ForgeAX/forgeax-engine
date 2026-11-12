import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import { EDGE_SHARP, type EditMesh } from './mesh';
import type { OpDiagnostic } from './ops';

/**
 * Half-sharp crease strength lives in the edge flag byte next to the intent bits: bit 0 is
 * `EDGE_SHARP`, bit 1 the seam, bits 2..7 a level code `c`. Code 0 on a flagged edge is an
 * infinitely sharp crease (every cage authored before refined creases), code `c` >= 1 the finite
 * sharpness `c / CREASE_STEPS`. Every operation that copies edge flags therefore copies the
 * strength with them, and a cage with no half-sharp edge keeps its bytes.
 */
export const CREASE_STEPS = 4;
const CODE_SHIFT = 2;
const CODE_MASK = 0b11111100;
/** Sharpness at or above this is infinite, as in OpenSubdiv. */
export const CREASE_INFINITE = 10;
const MAX_CODE = CREASE_INFINITE * CREASE_STEPS - 1;

export const CREASE_BITS = EDGE_SHARP | CODE_MASK;

/** Flag byte of a crease with the given sharpness on top of the other intent bits. */
export function withCrease(flags: number, sharpness: number): number {
  const plain = flags & ~(EDGE_SHARP | CODE_MASK);
  if (!(sharpness > 0)) return plain;
  if (sharpness >= CREASE_INFINITE) return plain | EDGE_SHARP;
  const code = Math.min(MAX_CODE, Math.max(1, Math.round(sharpness * CREASE_STEPS)));
  return plain | EDGE_SHARP | (code << CODE_SHIFT);
}

/**
 * Flag byte of two edges that become one: intent bits unite and the crease keeps the larger
 * sharpness, so an infinite crease never turns finite and a finite one never adds up.
 */
export function mergeFlags(a: number, b: number): number {
  return withCrease((a | b) & ~CREASE_BITS, Math.max(flagSharpness(a), flagSharpness(b)));
}

/** Flag byte with intent bit(s) `flag` set (an infinite crease for `EDGE_SHARP`) or cleared with its level. */
export function setFlag(flags: number, flag: number, on: boolean): number {
  if (on) return mergeFlags(flags, flag);
  return flags & ~flag & ((flag & EDGE_SHARP) !== 0 ? ~CODE_MASK : 0xff);
}

/** The sharpness a flag byte stores (`fallback` for a flagged edge with no level, 0 for a smooth edge). */
export function flagSharpness(flags: number, fallback = Infinity): number {
  if ((flags & EDGE_SHARP) === 0) return 0;
  const code = (flags & CODE_MASK) >> CODE_SHIFT;
  if (code !== 0) return code / CREASE_STEPS;
  return fallback >= CREASE_INFINITE ? Infinity : fallback;
}

/**
 * Crease strength of an edge: infinite on an open boundary, 0 when smooth. `fallback` is the
 * strength of flagged edges that store no level (default infinite).
 */
export function edgeSharpness(mesh: EditMesh, e: number, fallback = Infinity): number {
  return mesh.isBoundaryEdge(e) ? Infinity : flagSharpness(mesh.eFlags[e] as number, fallback);
}

/**
 * Blend weights of the Catmull-Clark vertex rules for a vertex whose sharp edges have the
 * given sharpness (any order): `crease` blends the smooth rule toward the crease rule, `corner`
 * the crease rule toward the corner rule. They are the second and third largest sharpness
 * clamped to 0..1, so integer and infinite creases select one rule and a fraction blends two.
 */
export function creaseWeights(sharpness: readonly number[]): { crease: number; corner: number } {
  const sorted = sharpness.filter((s) => s > 0).sort((a, b) => b - a);
  const clamp = (s: number | undefined) => Math.min(1, Math.max(0, s ?? 0));
  return { crease: clamp(sorted[1]), corner: clamp(sorted[2]) };
}

/**
 * Set the crease strength of edges: a positive finite value is a half-sharp crease (stored
 * in steps of 1/4, below 10), `Infinity` or 10 and more an infinitely sharp one, 0 clears the
 * crease. Other intent flags stay.
 */
export function markCrease(
  mesh: EditMesh,
  edges: readonly number[],
  sharpness: number,
  diagnostics: OpDiagnostic[],
): Result<{ edges: number }, ModelingError> {
  if (typeof sharpness !== 'number' || Number.isNaN(sharpness) || sharpness < 0) {
    return err(
      modelingError('model-invalid-argument', 'sharpness is 0 or greater (Infinity is allowed)', {
        sharpness,
      }),
    );
  }
  for (const e of edges) mesh.eFlags[e] = withCrease(mesh.eFlags[e] as number, sharpness);
  if (sharpness > 0 && sharpness < CREASE_INFINITE) {
    const open = edges.filter((e) => mesh.isBoundaryEdge(e)).length;
    if (open > 0) {
      diagnostics.push({
        severity: 'warn',
        message: `${open} open-boundary edges are always infinitely sharp; sharpness ${sharpness} has no effect on them`,
        detail: { sharpness, boundaryEdges: open },
      });
    }
  }
  const stored = flagSharpness(withCrease(0, sharpness));
  if (sharpness > 0 && sharpness < CREASE_INFINITE && stored !== sharpness) {
    diagnostics.push({
      severity: 'warn',
      message: `sharpness ${sharpness} is stored as ${stored} (steps of 1/${CREASE_STEPS})`,
      detail: { sharpness, stored },
    });
  }
  return ok({ edges: edges.length });
}
