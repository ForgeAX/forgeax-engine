/**
 * CPU reference of the weighted blended OIT depth weight and composite.
 *
 * The WGSL module `forgeax_material::oit` (packages/shader/src/oit.wgsl)
 * declares the same constants and formula; `oit-weight.unit.test.ts` parses
 * the WGSL constants and fails on any drift. Pixel tests derive expected probe
 * values from this module, so the probes and the shader share one formula.
 */
export const OIT_WEIGHT_MIN = 0.01;
export const OIT_WEIGHT_MAX = 500.0;
export const OIT_WEIGHT_SCALE = 10.0;
export const OIT_WEIGHT_NEAR = 5.0;
export const OIT_WEIGHT_FAR = 200.0;
export const OIT_WEIGHT_BIAS = 0.00001;
export const OIT_MIN_ALPHA = 0.001;
/** Composite guard on the accumulated weight denominator. */
export const OIT_COMPOSITE_EPSILON = 0.00001;

/** McGuire-Bavoil depth weight on linear camera distance. */
export function oitDepthWeight(viewDistance: number): number {
  const d = Math.max(viewDistance, 0);
  const near = d / OIT_WEIGHT_NEAR;
  const far = d / OIT_WEIGHT_FAR;
  const far2 = far * far;
  const denominator = OIT_WEIGHT_BIAS + near * near + far2 * far2 * far2;
  return Math.min(Math.max(OIT_WEIGHT_SCALE / denominator, OIT_WEIGHT_MIN), OIT_WEIGHT_MAX);
}

/** One transparent fragment as seen by the reference model. */
export interface OitFragment {
  /** Straight (non-premultiplied) linear color. */
  readonly color: readonly [number, number, number];
  readonly alpha: number;
  readonly viewDistance: number;
}

/** The accumulation targets after every fragment: accum rgba and weight r. */
export interface OitAccumulation {
  /** sum(c * a * w). */
  readonly color: [number, number, number];
  /** prod(1 - a), the accum target's alpha. */
  readonly revealage: number;
  /** sum(a * w), the weight target. */
  readonly weight: number;
}

/** The order-independent sums the accumulate pass writes for one pixel. */
export function oitAccumulation(fragments: readonly OitFragment[]): OitAccumulation {
  const color: [number, number, number] = [0, 0, 0];
  let weight = 0;
  let revealage = 1;
  for (const fragment of fragments) {
    if (!(fragment.alpha >= OIT_MIN_ALPHA)) continue;
    const a = Math.min(fragment.alpha, 1);
    const w = oitDepthWeight(fragment.viewDistance);
    for (let i = 0; i < 3; i += 1) color[i] = (color[i] ?? 0) + (fragment.color[i] ?? 0) * a * w;
    weight += a * w;
    revealage *= 1 - a;
  }
  return { color, revealage, weight };
}

/**
 * Composite a set of fragments over an opaque background with the renderer's
 * WBOIT formula. The result is independent of fragment order by construction.
 */
export function oitComposite(
  fragments: readonly OitFragment[],
  background: readonly [number, number, number],
): [number, number, number] {
  const { color, revealage, weight } = oitAccumulation(fragments);
  if (revealage >= 1) return [background[0], background[1], background[2]];
  const denominator = Math.max(weight, OIT_COMPOSITE_EPSILON);
  const coverage = 1 - revealage;
  return [0, 1, 2].map(
    (i) => ((color[i] ?? 0) / denominator) * coverage + (background[i] ?? 0) * revealage,
  ) as [number, number, number];
}

/** Exact back-to-front over compositing; fragments are sorted by distance. */
export function sortedComposite(
  fragments: readonly OitFragment[],
  background: readonly [number, number, number],
): [number, number, number] {
  const ordered = [...fragments].sort((a, b) => b.viewDistance - a.viewDistance);
  const out: [number, number, number] = [background[0], background[1], background[2]];
  for (const fragment of ordered) {
    const a = Math.min(Math.max(fragment.alpha, 0), 1);
    for (let i = 0; i < 3; i += 1) out[i] = (fragment.color[i] ?? 0) * a + (out[i] ?? 0) * (1 - a);
  }
  return out;
}
