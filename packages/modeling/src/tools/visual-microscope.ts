/**
 * `model.microscope` core: per-feature pixel-level scoring of a render against a reference on
 * the bbox-aligned grid. A feature is a region of interest in subject-bbox coordinates; its score
 * is its worst patch (a missing small feature cannot be averaged away by a good body), and a
 * critical feature that cannot be scored fails the gate instead of being skipped.
 */
import type { Issue } from '../report';
import { environmentOf, type ToolEnvironment } from './environment';
import { type ColorImage, deltaE2000, srgbToLab, ssim } from './image-metrics';
import {
  type Aligned,
  alignToGrid,
  dilate,
  type Foreground,
  foregroundMask,
  shiftAligned,
} from './visual-mask';
import { edgeBits } from './visual-signals';

/** Version tag of the `model.microscope` report. */
export const MODEL_MICROSCOPE_REPORT = 'forgeax.model.microscope/1';

export type FeatureTier = 'critical' | 'important' | 'detail';

export const FEATURE_TIERS: readonly FeatureTier[] = ['critical', 'important', 'detail'];

/** Minimum feature score per tier unless the feature sets `minimumScore` (provisional). */
export const TIER_MINIMUM: Readonly<Record<FeatureTier, number>> = {
  critical: 0.6,
  important: 0.5,
  detail: 0.4,
};

/** Weights of a patch score; the color term is dropped for concave features and the rest renormalized. */
export const PATCH_WEIGHTS = { ssim: 0.4, edges: 0.4, color: 0.2 } as const;

/** Smallest feature extent in reference pixels the scorer accepts as resolved. */
export const MIN_REFERENCE_PIXELS = 24;

/** Largest registration shift in grid pixels a feature may be searched over (default 8 of 256). */
export const DEFAULT_MAX_SHIFT = 8;

const PATCH = 16;
const MIN_FOOTPRINT = 32;

export interface Feature {
  readonly id: string;
  readonly tier: FeatureTier;
  /** [x0, y0, x1, y1] as fractions of the subject bbox (0..1, top-left origin). */
  readonly roi: readonly [number, number, number, number];
  readonly minimumScore?: number;
  /** Cavity or recess: shading differs from albedo there, so the color term is skipped. */
  readonly concave?: boolean;
  /** Visible-footprint mask in reference image pixels (1 = compare), same size as the reference. */
  readonly mask?: Uint8Array;
}

export type MicroscopeCode =
  | 'mask-unreliable'
  | 'feature-below-minimum'
  | 'insufficient-reference-resolution'
  | 'no-reference-signal';

export interface PatchScore {
  readonly x: number;
  readonly y: number;
  readonly score: number;
  readonly ssim: number;
  readonly edges: number;
  readonly color?: number;
}

export interface FeatureScore {
  readonly id: string;
  readonly tier: FeatureTier;
  readonly minimumScore: number;
  readonly status: 'scored' | MicroscopeCode;
  /** Worst patch score. */
  readonly score?: number;
  readonly pass: boolean;
  readonly patches: number;
  readonly referencePixels: number;
  readonly worst?: PatchScore;
  /** Grid shift of the render that best registers this feature (0, 0 when none helped). */
  readonly shift?: readonly [number, number];
}

export interface ModelMicroscopeReport {
  readonly schema: typeof MODEL_MICROSCOPE_REPORT;
  readonly environment: ToolEnvironment;
  readonly pass: boolean;
  readonly issues: readonly Issue<MicroscopeCode>[];
  readonly features: readonly FeatureScore[];
  readonly weights: typeof PATCH_WEIGHTS;
  readonly size: number;
  readonly maxShift: number;
}

export function checkFeatures(features: readonly Feature[]): string | undefined {
  if (features.length === 0) return 'features lists at least one feature';
  const seen = new Set<string>();
  for (const f of features) {
    if (typeof f.id !== 'string' || f.id === '' || seen.has(f.id))
      return `feature ids are unique non-empty strings (${String(f.id)})`;
    seen.add(f.id);
    if (!FEATURE_TIERS.includes(f.tier))
      return `feature ${f.id}: tier is critical, important or detail`;
    const [x0, y0, x1, y1] = f.roi;
    if (!(x0 >= 0 && y0 >= 0 && x1 <= 1 && y1 <= 1 && x0 < x1 && y0 < y1))
      return `feature ${f.id}: roi is [x0, y0, x1, y1] with 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1`;
    if (f.minimumScore !== undefined && !(f.minimumScore > 0 && f.minimumScore <= 1))
      return `feature ${f.id}: minimumScore is in (0, 1]`;
  }
  return undefined;
}

function aligned(image: ColorImage, fg: Foreground, size: number): Aligned {
  return alignToGrid(image, fg.mask, fg.bbox as NonNullable<Foreground['bbox']>, size);
}

/** Resample a reference-sized pixel mask onto the aligned grid (nearest through bilinear > 0.5). */
function gridMask(mask: Uint8Array, image: ColorImage, fg: Foreground, size: number): Uint8Array {
  const rgb = new Float32Array(mask.length * 3);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] !== 0 ? 1 : 0;
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v;
    rgb[i * 3 + 2] = v;
  }
  const ones = new Uint8Array(mask.length).fill(1);
  const a = alignToGrid(
    { width: image.width, height: image.height, rgb },
    ones,
    fg.bbox as NonNullable<Foreground['bbox']>,
    size,
  );
  const out = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = (a.image.rgb[i * 3] as number) > 0.5 ? 1 : 0;
  return out;
}

interface RenderState {
  readonly b: Aligned;
  readonly eb: Uint8Array;
  readonly db: Uint8Array;
  readonly ssimMap: Float32Array;
}

/**
 * The shift of the render within `maxShift` grid pixels that best overlaps the reference inside the
 * region (mean of two-way edge overlap and silhouette IoU); the smallest shift wins ties. The
 * bbox alignment is exact only while both subjects have the same extent, so a local edit that
 * moves the bbox would otherwise shift every untouched feature out of register.
 */
function register(
  a: Aligned,
  b: Aligned,
  eb: Uint8Array,
  ea: Uint8Array,
  da: Uint8Array,
  roi: readonly [number, number, number, number],
  size: number,
  maxShift: number,
): readonly [number, number] {
  if (maxShift === 0) return [0, 0];
  const [x0, y0, x1, y1] = roi;
  const shifts: [number, number][] = [];
  for (let dy = -maxShift; dy <= maxShift; dy++)
    for (let dx = -maxShift; dx <= maxShift; dx++) shifts.push([dx, dy]);
  shifts.sort((p, q) => p[0] * p[0] + p[1] * p[1] - (q[0] * q[0] + q[1] * q[1]));
  let best: readonly [number, number] = [0, 0];
  let bestScore = -1;
  for (const [dx, dy] of shifts) {
    let ca = 0;
    let cb = 0;
    let hitA = 0;
    let hitB = 0;
    let both = 0;
    let either = 0;
    for (let y = y0; y < y1; y++) {
      const sy = y - dy;
      for (let x = x0; x < x1; x++) {
        const sx = x - dx;
        const i = y * size + x;
        const inside = sx >= 0 && sy >= 0 && sx < size && sy < size;
        const j = sy * size + sx;
        const mb = inside && b.mask[j] !== 0;
        const ma = a.mask[i] !== 0;
        if (ma || mb) either++;
        if (ma && mb) both++;
        if (ea[i] !== 0) {
          ca++;
          if (inside && eb[j] !== 0) hitA++;
        }
        if (inside && eb[j] !== 0) {
          cb++;
          if (da[i] !== 0) hitB++;
        }
      }
    }
    const recall = ca === 0 ? 1 : hitA / ca;
    const precision = cb === 0 ? (ca === 0 ? 1 : 0) : hitB / cb;
    const iou = either === 0 ? 1 : both / either;
    const score = ((recall + precision) / 2 + iou) / 2;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = [dx, dy];
    }
  }
  return best;
}

export function scoreFeatures(
  reference: { readonly image: ColorImage; readonly alpha?: Uint8Array },
  render: { readonly image: ColorImage; readonly alpha?: Uint8Array },
  features: readonly Feature[],
  options: { readonly size?: number; readonly maxShift?: number } = {},
): ModelMicroscopeReport {
  const size = options.size ?? 256;
  const maxShift = options.maxShift ?? DEFAULT_MAX_SHIFT;
  const fgR = foregroundMask(reference.image, reference.alpha);
  const fgT = foregroundMask(render.image, render.alpha);
  const issues: Issue<MicroscopeCode>[] = [];
  if (!fgR.reliable || !fgT.reliable) {
    for (const [subject, f] of [
      ['reference', fgR],
      ['render', fgT],
    ] as const)
      if (!f.reliable)
        issues.push({
          code: 'mask-unreliable',
          severity: 'error',
          detail: { subject, reason: f.reason ?? null, coverage: f.coverage },
        });
    return {
      schema: MODEL_MICROSCOPE_REPORT,
      environment: environmentOf(),
      pass: false,
      issues,
      features: features.map((f) => ({
        id: f.id,
        tier: f.tier,
        minimumScore: f.minimumScore ?? TIER_MINIMUM[f.tier],
        status: 'mask-unreliable' as const,
        pass: false,
        patches: 0,
        referencePixels: 0,
      })),
      weights: PATCH_WEIGHTS,
      size,
      maxShift,
    };
  }
  const a = aligned(reference.image, fgR, size);
  const b0 = aligned(render.image, fgT, size);
  const refBox = fgR.bbox as NonNullable<Foreground['bbox']>;
  const refExtent = [refBox.x1 - refBox.x0, refBox.y1 - refBox.y0] as const;
  const ea = edgeBits(a, size).bits;
  const da = dilate(ea, size, size, 2);
  const eb0 = edgeBits(b0, size).bits;
  const states = new Map<number, RenderState>();
  const stateAt = (dx: number, dy: number): RenderState => {
    const key = dy * 4096 + dx;
    let st = states.get(key);
    if (st === undefined) {
      const b = shiftAligned(b0, dx, dy, size);
      const eb = edgeBits(b, size).bits;
      st = { b, eb, db: dilate(eb, size, size, 2), ssimMap: ssim(a.image, b.image).map };
      states.set(key, st);
    }
    return st;
  };
  const lab = (img: ColorImage, i: number) =>
    srgbToLab(img.rgb[i * 3] as number, img.rgb[i * 3 + 1] as number, img.rgb[i * 3 + 2] as number);
  const boxW = a.box.x1 - a.box.x0;
  const boxH = a.box.y1 - a.box.y0;
  const scored: FeatureScore[] = [];
  const ordered = [...features].sort(
    (p, q) => FEATURE_TIERS.indexOf(p.tier) - FEATURE_TIERS.indexOf(q.tier),
  );
  for (const f of ordered) {
    const minimumScore = f.minimumScore ?? TIER_MINIMUM[f.tier];
    const base = { id: f.id, tier: f.tier, minimumScore };
    const [fx0, fy0, fx1, fy1] = f.roi;
    const sourceW = (fx1 - fx0) * (refExtent[0] as number);
    const sourceH = (fy1 - fy0) * (refExtent[1] as number);
    if (Math.min(sourceW, sourceH) < MIN_REFERENCE_PIXELS) {
      issues.push({
        code: 'insufficient-reference-resolution',
        severity: 'error',
        detail: {
          subject: f.id,
          tier: f.tier,
          referencePixels: [Math.round(sourceW), Math.round(sourceH)],
          minimum: MIN_REFERENCE_PIXELS,
        },
      });
      scored.push({
        ...base,
        status: 'insufficient-reference-resolution',
        pass: false,
        patches: 0,
        referencePixels: 0,
      });
      continue;
    }
    const gx0 = Math.max(0, Math.floor(a.box.x0 + fx0 * boxW));
    const gy0 = Math.max(0, Math.floor(a.box.y0 + fy0 * boxH));
    const gx1 = Math.min(size, Math.ceil(a.box.x0 + fx1 * boxW));
    const gy1 = Math.min(size, Math.ceil(a.box.y0 + fy1 * boxH));
    const footprint =
      f.mask === undefined ? undefined : gridMask(f.mask, reference.image, fgR, size);
    const [sx, sy] = register(a, b0, eb0, ea, da, [gx0, gy0, gx1, gy1], size, maxShift);
    const { b, eb, db, ssimMap } = stateAt(sx, sy);
    const patches: PatchScore[] = [];
    let referencePixels = 0;
    for (let py = gy0; py < gy1; py += PATCH)
      for (let px = gx0; px < gx1; px += PATCH) {
        const x1 = Math.min(gx1, px + PATCH);
        const y1 = Math.min(gy1, py + PATCH);
        let n = 0;
        let ssimSum = 0;
        let ca = 0;
        let cb = 0;
        let hitA = 0;
        let hitB = 0;
        let both = 0;
        const colors: number[] = [];
        for (let y = py; y < y1; y++)
          for (let x = px; x < x1; x++) {
            const i = y * size + x;
            if (footprint !== undefined && footprint[i] === 0) continue;
            if (a.mask[i] === 0 && b.mask[i] === 0) continue;
            if (a.mask[i] !== 0) referencePixels++;
            n++;
            ssimSum += ssimMap[i] as number;
            if (ea[i] !== 0) {
              ca++;
              if (db[i] !== 0) hitA++;
            }
            if (eb[i] !== 0) {
              cb++;
              if (da[i] !== 0) hitB++;
            }
            if (a.mask[i] !== 0 && b.mask[i] !== 0) {
              both++;
              colors.push(deltaE2000(lab(a.image, i), lab(b.image, i)));
            }
          }
        if (n < (x1 - px) * (y1 - py) * 0.25) continue;
        const ssimScore = Math.max(0, Math.min(1, ssimSum / n));
        const recall = ca === 0 ? 1 : hitA / ca;
        const precision = cb === 0 ? (ca === 0 ? 1 : 0) : hitB / cb;
        const edgeScore = (recall + precision) / 2;
        const color =
          f.concave === true || both === 0
            ? undefined
            : Math.max(0, 1 - colors.reduce((s, v) => s + v, 0) / both / 20);
        const wSum =
          PATCH_WEIGHTS.ssim +
          PATCH_WEIGHTS.edges +
          (color === undefined ? 0 : PATCH_WEIGHTS.color);
        const score =
          (PATCH_WEIGHTS.ssim * ssimScore +
            PATCH_WEIGHTS.edges * edgeScore +
            (color === undefined ? 0 : PATCH_WEIGHTS.color * color)) /
          wSum;
        patches.push({
          x: px,
          y: py,
          score,
          ssim: ssimScore,
          edges: edgeScore,
          ...(color === undefined ? {} : { color }),
        });
      }
    if (referencePixels < MIN_FOOTPRINT || patches.length === 0) {
      issues.push({
        code: 'no-reference-signal',
        severity: 'error',
        detail: { subject: f.id, tier: f.tier, referencePixels },
      });
      scored.push({
        ...base,
        status: 'no-reference-signal',
        pass: false,
        patches: 0,
        referencePixels,
      });
      continue;
    }
    const worst = patches.reduce((p, q) => (q.score < p.score ? q : p));
    const pass = worst.score >= minimumScore;
    if (!pass)
      issues.push({
        code: 'feature-below-minimum',
        severity: 'error',
        detail: {
          subject: f.id,
          tier: f.tier,
          score: worst.score,
          minimumScore,
          worstPatch: { x: worst.x, y: worst.y, size: PATCH },
          ssim: worst.ssim,
          edges: worst.edges,
        },
      });
    scored.push({
      ...base,
      status: 'scored',
      score: worst.score,
      pass,
      patches: patches.length,
      referencePixels,
      worst,
      shift: [sx, sy],
    });
  }
  return {
    schema: MODEL_MICROSCOPE_REPORT,
    environment: environmentOf(),
    pass: scored.every((s) => s.pass),
    issues,
    features: scored,
    weights: PATCH_WEIGHTS,
    size,
    maxShift,
  };
}
