/**
 * `model.turntable` core: does a subject survive orbiting? Every required azimuth must be
 * captured, the silhouette must not collapse between views (a billboard is thin edge-on) and no
 * view may show a through-hole the declaration does not allow.
 */
import type { Issue } from '../report';
import { environmentOf, type ToolEnvironment } from './environment';
import type { ColorImage } from './image-metrics';
import { enclosedHoles, type Foreground, foregroundMask } from './visual-mask';

/** Version tag of the `model.turntable` report. */
export const MODEL_TURNTABLE_REPORT = 'forgeax.model.turntable/1';

export type TurntableCode =
  | 'mask-unreliable'
  | 'azimuth-missing'
  | 'silhouette-collapse'
  | 'through-hole';

export interface TurntableCapture {
  /** Camera azimuth in degrees; any real, wrapped into [0, 360). */
  readonly azimuth: number;
  readonly image: ColorImage;
  readonly alpha?: Uint8Array;
}

export interface TurntableOptions {
  /** Azimuths that must be present (default 0, 90, 180, 270). */
  readonly required?: readonly number[];
  /** How far a capture may sit from a required azimuth (default 5 degrees). */
  readonly tolerance?: number;
  /** Smallest silhouette area against the frontal view (default 0.15). */
  readonly minAreaRatio?: number;
  /** The subject legitimately has through-holes (a ring, a handle): holes are reported, not failed. */
  readonly allowHoles?: boolean;
}

export const DEFAULT_REQUIRED: readonly number[] = [0, 90, 180, 270];

/** A hole must exceed both bounds to count (noise from anti-aliasing and segmentation). */
export const HOLE_MIN_PIXELS = 4;
export const HOLE_MIN_SHARE = 0.01;

export interface ViewFacts {
  readonly azimuth: number;
  readonly area?: number;
  readonly areaRatio?: number;
  readonly holes?: number;
  readonly holeComponents?: number;
  readonly mask: Pick<Foreground, 'source' | 'coverage' | 'reliable' | 'reason'>;
}

export interface ModelTurntableReport {
  readonly schema: typeof MODEL_TURNTABLE_REPORT;
  readonly environment: ToolEnvironment;
  readonly pass: boolean;
  readonly issues: readonly Issue<TurntableCode>[];
  readonly views: readonly ViewFacts[];
  readonly required: readonly number[];
  readonly thresholds: {
    readonly tolerance: number;
    readonly minAreaRatio: number;
    readonly allowHoles: boolean;
  };
}

const wrap = (deg: number) => ((deg % 360) + 360) % 360;
const angular = (a: number, b: number) => {
  const d = Math.abs(wrap(a) - wrap(b));
  return Math.min(d, 360 - d);
};

export function checkTurntableOptions(
  captures: readonly TurntableCapture[],
  options: TurntableOptions,
): string | undefined {
  if (captures.length === 0) return 'captures lists at least one azimuth capture';
  for (const c of captures)
    if (!Number.isFinite(c.azimuth)) return 'every capture has a finite azimuth in degrees';
  const { tolerance, minAreaRatio, required } = options;
  if (tolerance !== undefined && !(tolerance >= 0 && tolerance < 45))
    return 'tolerance is in [0, 45)';
  if (minAreaRatio !== undefined && !(minAreaRatio > 0 && minAreaRatio < 1))
    return 'minAreaRatio is in (0, 1)';
  if (required?.some((r) => !Number.isFinite(r))) return 'required azimuths are finite degrees';
  return undefined;
}

export function evaluateTurntable(
  captures: readonly TurntableCapture[],
  options: TurntableOptions = {},
): ModelTurntableReport {
  const required = (options.required ?? DEFAULT_REQUIRED).map(wrap);
  const tolerance = options.tolerance ?? 5;
  const minAreaRatio = options.minAreaRatio ?? 0.15;
  const allowHoles = options.allowHoles ?? false;
  const issues: Issue<TurntableCode>[] = [];
  const ordered = [...captures].sort((p, q) => wrap(p.azimuth) - wrap(q.azimuth));
  const facts: ViewFacts[] = [];
  const raw = ordered.map((c) => ({ c, fg: foregroundMask(c.image, c.alpha) }));
  const front = raw.reduce((p, q) => (angular(q.c.azimuth, 0) < angular(p.c.azimuth, 0) ? q : p));
  const frontArea = front.fg.reliable
    ? front.fg.coverage * front.c.image.width * front.c.image.height
    : undefined;
  for (const { c, fg } of raw) {
    const azimuth = wrap(c.azimuth);
    const mask = {
      source: fg.source,
      coverage: fg.coverage,
      reliable: fg.reliable,
      ...(fg.reason === undefined ? {} : { reason: fg.reason }),
    };
    if (!fg.reliable) {
      issues.push({
        code: 'mask-unreliable',
        severity: 'error',
        detail: { subject: `azimuth ${azimuth}`, reason: fg.reason ?? null, coverage: fg.coverage },
      });
      facts.push({ azimuth, mask });
      continue;
    }
    const area = fg.coverage * c.image.width * c.image.height;
    const areaRatio = frontArea === undefined ? undefined : area / frontArea;
    const { holes, components } = enclosedHoles(fg.mask, c.image.width, c.image.height);
    facts.push({
      azimuth,
      area,
      ...(areaRatio === undefined ? {} : { areaRatio }),
      holes,
      holeComponents: components,
      mask,
    });
    if (areaRatio !== undefined && areaRatio < minAreaRatio)
      issues.push({
        code: 'silhouette-collapse',
        severity: 'error',
        detail: { subject: `azimuth ${azimuth}`, areaRatio, minAreaRatio },
      });
    if (holes > HOLE_MIN_PIXELS && holes > HOLE_MIN_SHARE * area)
      issues.push({
        code: 'through-hole',
        severity: allowHoles ? 'info' : 'error',
        detail: {
          subject: `azimuth ${azimuth}`,
          holePixels: holes,
          components,
          silhouettePixels: area,
        },
      });
  }
  for (const r of required) {
    const near = ordered.filter((c) => angular(c.azimuth, r) <= tolerance);
    if (near.length === 0)
      issues.push({
        code: 'azimuth-missing',
        severity: 'error',
        detail: {
          subject: `azimuth ${r}`,
          nearest:
            ordered.map((c) => wrap(c.azimuth)).sort((p, q) => angular(p, r) - angular(q, r))[0] ??
            null,
          tolerance,
        },
      });
  }
  return {
    schema: MODEL_TURNTABLE_REPORT,
    environment: environmentOf(),
    pass: issues.every((i) => i.severity !== 'error'),
    issues,
    views: facts,
    required,
    thresholds: { tolerance, minAreaRatio, allowHoles },
  };
}
