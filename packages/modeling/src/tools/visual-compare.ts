import { encodePng } from '@forgeax/engine-image/png';
import { maskIoU } from '../drawing-check';
import type { Issue } from '../report';
import { environmentOf, type ToolEnvironment } from './environment';
import { type ColorImage, heatmapPng, imageDeltaE, type PixelMask, readPng } from './image-metrics';
import { type Aligned, alignToGrid, type Foreground, foregroundMask } from './visual-mask';
import {
  blowout,
  edges,
  flat,
  HUE_ZONE_DELTA_E,
  HUE_ZONE_GATE_DELTA_E,
  HUE_ZONE_MISSING_SHARE,
  type HueZone,
  hueZones,
  type InteriorDifference,
  interiorDifference,
  objectness,
  PALETTE_DELTA_E,
  palette,
  phash,
  proportion,
  SIGNALS,
  type Signal,
  type SignalName,
  structural,
  symmetry,
  tonal,
} from './visual-signals';

/** Version tag of the `model.compare` report. */
export const MODEL_COMPARE_REPORT = 'forgeax.model.compare/1';

export type CompareCode =
  | 'mask-unreliable'
  | 'silhouette-mismatch'
  | 'scale-mismatch'
  | 'palette-mismatch'
  | 'hue-zone-mismatch'
  | 'signal-below-bound'
  | 'fidelity-below-target';

export type CompareVerdict = 'pass' | 'reject' | 'low-confidence' | 'unverifiable';

export interface CompareOptions {
  /** Aligned grid edge in pixels (default 192, 64..512). */
  readonly size?: number;
  /** Weighted fidelity the render must reach (default 0.7). */
  readonly target?: number;
  /** Silhouette IoU the render must reach (default 0.85). */
  readonly minIoU?: number;
  /** Largest relative difference of the subject's frame share (default 0.08). */
  readonly maxScaleDelta?: number;
  /** Fractional height band [top, bottom] of the subject for the interior difference. */
  readonly band?: readonly [number, number];
}

export interface CompareResult {
  readonly report: ModelCompareReport;
  /** The four-panel sheet (reference, render, delta E, edge difference) as PNG bytes. */
  readonly sheet: Uint8Array;
  readonly heatmap: Uint8Array;
}

export interface ModelCompareReport {
  readonly schema: typeof MODEL_COMPARE_REPORT;
  readonly environment: ToolEnvironment;
  readonly pass: boolean;
  readonly verdict: CompareVerdict;
  readonly issues: readonly Issue<CompareCode>[];
  readonly hard: {
    readonly silhouetteIoU?: number;
    readonly scaleDelta?: number;
    readonly paletteDeltaE?: number;
    readonly masks: {
      readonly reference: MaskFacts;
      readonly render: MaskFacts;
    };
  };
  readonly signals?: Readonly<Record<SignalName, Signal>>;
  /** Weighted mean of the signal scores; the weights are in `weights`. */
  readonly fidelity?: number;
  /** Largest minus smallest signal score: a wide spread means the signals disagree. */
  readonly spread?: number;
  readonly weights: Readonly<Record<SignalName, number>>;
  readonly hueZones?: readonly HueZone[];
  readonly hueZoneBound: number;
  /** Per-zone CIEDE2000 above which a zone present on both subjects is a hard failure. */
  readonly hueZoneGate: number;
  readonly interior?: InteriorDifference;
  readonly deltaE?: { readonly mean: number; readonly p95: number };
  readonly thresholds: {
    readonly size: number;
    readonly target: number;
    readonly minIoU: number;
    readonly maxScaleDelta: number;
  };
  readonly artifacts?: readonly string[];
}

interface MaskFacts {
  readonly source: Foreground['source'];
  readonly coverage: number;
  readonly reliable: boolean;
  readonly reason?: Foreground['reason'];
}

const maskFacts = (f: Foreground): MaskFacts => ({
  source: f.source,
  coverage: f.coverage,
  reliable: f.reliable,
  ...(f.reason === undefined ? {} : { reason: f.reason }),
});

const WEIGHTS = Object.fromEntries(
  (Object.keys(SIGNALS) as SignalName[]).map((k) => [k, SIGNALS[k].weight]),
) as Record<SignalName, number>;

export function checkCompareOptions(options: CompareOptions): string | undefined {
  const { size, target, minIoU, maxScaleDelta, band } = options;
  if (
    size !== undefined &&
    !(Number.isInteger(size) && size >= 64 && size <= 512 && size % 32 === 0)
  )
    return 'size is a multiple of 32 in 64..512';
  for (const [name, v] of [
    ['target', target],
    ['minIoU', minIoU],
    ['maxScaleDelta', maxScaleDelta],
  ] as const)
    if (v !== undefined && !(Number.isFinite(v) && v > 0 && v <= 1)) return `${name} is in (0, 1]`;
  if (band !== undefined && !(band[0] >= 0 && band[1] <= 1 && band[0] < band[1]))
    return 'band is [top, bottom] with 0 <= top < bottom <= 1';
  return undefined;
}

function frameShare(f: Foreground, image: ColorImage): number {
  const b = f.bbox as NonNullable<Foreground['bbox']>;
  return ((b.x1 - b.x0) * (b.y1 - b.y0)) / (image.width * image.height);
}

function rgbaOf(image: ColorImage, mask: PixelMask | undefined): Uint8Array {
  const out = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    const on = mask === undefined || mask[i] !== 0;
    for (let c = 0; c < 3; c++)
      out[i * 4 + c] = on ? Math.round((image.rgb[i * 3 + c] as number) * 255) : 24;
    out[i * 4 + 3] = 255;
  }
  return out;
}

function sheetOf(
  size: number,
  ref: Aligned,
  test: Aligned,
  heat: Uint8Array,
  edgeBits: { reference: Uint8Array; test: Uint8Array },
): Uint8Array {
  const panels: Uint8Array[] = [
    rgbaOf(ref.image, ref.mask),
    rgbaOf(test.image, test.mask),
    heat,
    (() => {
      const out = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        const a = edgeBits.reference[i] !== 0;
        const b = edgeBits.test[i] !== 0;
        const rgb =
          a && b ? [235, 235, 235] : a ? [230, 60, 60] : b ? [60, 200, 230] : [24, 24, 28];
        out.set([...rgb, 255], i * 4);
      }
      return out;
    })(),
  ];
  const sheet = new Uint8Array(size * 4 * size * 4);
  panels.forEach((p, k) => {
    for (let y = 0; y < size; y++)
      sheet.set(p.subarray(y * size * 4, (y + 1) * size * 4), (y * size * 4 + k * size) * 4);
  });
  return encodePng(size * 4, size, sheet);
}

/** Compare a render with a reference image; both are PNG-decoded, any sizes. */
export function compareImages(
  reference: { readonly image: ColorImage; readonly alpha?: Uint8Array },
  render: { readonly image: ColorImage; readonly alpha?: Uint8Array },
  options: CompareOptions = {},
): CompareResult {
  const size = options.size ?? 192;
  const target = options.target ?? 0.7;
  const minIoU = options.minIoU ?? 0.85;
  const maxScaleDelta = options.maxScaleDelta ?? 0.08;
  const thresholds = { size, target, minIoU, maxScaleDelta };
  const fgR = foregroundMask(reference.image, reference.alpha);
  const fgT = foregroundMask(render.image, render.alpha);
  const issues: Issue<CompareCode>[] = [];
  const masks = { reference: maskFacts(fgR), render: maskFacts(fgT) };
  const empty = new Uint8Array(0);
  if (!fgR.reliable || !fgT.reliable) {
    for (const [side, f] of [
      ['reference', fgR],
      ['render', fgT],
    ] as const)
      if (!f.reliable)
        issues.push({
          code: 'mask-unreliable',
          severity: 'error',
          detail: { subject: side, reason: f.reason ?? null, coverage: f.coverage },
        });
    return {
      report: {
        schema: MODEL_COMPARE_REPORT,
        environment: environmentOf(),
        pass: false,
        verdict: 'unverifiable',
        issues,
        hard: { masks },
        weights: WEIGHTS,
        hueZoneBound: HUE_ZONE_DELTA_E,
        hueZoneGate: HUE_ZONE_GATE_DELTA_E,
        thresholds,
      },
      sheet: empty,
      heatmap: empty,
    };
  }
  const a = alignToGrid(reference.image, fgR.mask, fgR.bbox as never, size);
  const b = alignToGrid(render.image, fgT.mask, fgT.bbox as never, size);
  const iouResult = maskIoU(a.mask, b.mask);
  const silhouetteIoU = iouResult.ok ? iouResult.value.iou : 0;
  const sa = frameShare(fgR, reference.image);
  const sb = frameShare(fgT, render.image);
  const scaleDelta = Math.abs(sa - sb) / Math.max(sa, sb);
  if (silhouetteIoU < minIoU)
    issues.push({
      code: 'silhouette-mismatch',
      severity: 'error',
      detail: {
        subject: 'silhouette',
        iou: silhouetteIoU,
        minIoU,
        onlyReference: iouResult.ok ? iouResult.value.onlyA : 0,
        onlyRender: iouResult.ok ? iouResult.value.onlyB : 0,
      },
    });
  if (scaleDelta > maxScaleDelta)
    issues.push({
      code: 'scale-mismatch',
      severity: 'error',
      detail: { subject: 'scale', referenceShare: sa, renderShare: sb, scaleDelta, maxScaleDelta },
    });
  const paletteDeltaE = palette(a, b);
  if (paletteDeltaE > PALETTE_DELTA_E)
    issues.push({
      code: 'palette-mismatch',
      severity: 'error',
      detail: { subject: 'palette', deltaE: paletteDeltaE, maxDeltaE: PALETTE_DELTA_E },
    });
  const zones = hueZones(a, b);
  const refInside = a.mask.reduce((n, v) => n + (v === 0 ? 0 : 1), 0);
  const testInside = b.mask.reduce((n, v) => n + (v === 0 ? 0 : 1), 0);
  for (const z of zones) {
    const missing =
      z.deltaE === undefined && z.pass === false
        ? z.referencePixels > z.testPixels
          ? 'render'
          : 'reference'
        : undefined;
    if (z.deltaE !== undefined && z.deltaE > HUE_ZONE_GATE_DELTA_E)
      issues.push({
        code: 'hue-zone-mismatch',
        severity: 'error',
        detail: { subject: z.zone, deltaE: z.deltaE, maxDeltaE: HUE_ZONE_GATE_DELTA_E },
      });
    else if (missing !== undefined) {
      const share = Math.max(z.referencePixels / refInside, z.testPixels / testInside);
      issues.push({
        code: 'hue-zone-mismatch',
        severity: share >= HUE_ZONE_MISSING_SHARE ? 'error' : 'warn',
        detail: {
          subject: z.zone,
          missingFrom: missing,
          referencePixels: z.referencePixels,
          renderPixels: z.testPixels,
          share,
        },
      });
    }
  }
  const { bits: edgeBits, ...edgeReport } = edges(a, b, size);
  const sym = symmetry(a, b, size);
  const hash = phash(a, b, size);
  const signals: Record<SignalName, Signal> = {
    proportion: proportion(a, b),
    symmetry: sym,
    phash: hash,
    ssim: structural(a, b),
    edges: edgeReport,
    blowout: blowout(a, b),
    flat: flat(a, b, size),
    tonal: tonal(a, b),
    objectness: objectness(a, b, size),
  };
  const names = Object.keys(signals) as SignalName[];
  const weightSum = names.reduce((s, k) => s + WEIGHTS[k], 0);
  const fidelity = names.reduce((s, k) => s + WEIGHTS[k] * signals[k].score, 0) / weightSum;
  const scores = names.map((k) => signals[k].score);
  const spread =
    scores.reduce((m, v) => Math.max(m, v), -Infinity) -
    scores.reduce((m, v) => Math.min(m, v), Infinity);
  const hardFailed = issues.some((i) => i.severity === 'error');
  const below = fidelity < target;
  for (const k of names)
    if (!signals[k].pass)
      issues.push({
        code: 'signal-below-bound',
        severity: below ? 'warn' : 'info',
        detail: { subject: k, value: signals[k].value, bound: SIGNALS[k].bound },
      });
  if (below)
    issues.push({
      code: 'fidelity-below-target',
      severity: 'error',
      detail: { subject: 'fidelity', fidelity, target },
    });
  const union = new Uint8Array(size * size);
  for (let i = 0; i < union.length; i++) union[i] = a.mask[i] !== 0 || b.mask[i] !== 0 ? 1 : 0;
  const de = imageDeltaE(a.image, b.image, union);
  const heatmap = heatmapPng(de.map, size, size, 20, union);
  const failed = hardFailed || below;
  const verdict: CompareVerdict = !failed
    ? 'pass'
    : !hardFailed && spread > 0.35
      ? 'low-confidence'
      : 'reject';
  return {
    report: {
      schema: MODEL_COMPARE_REPORT,
      environment: environmentOf(),
      pass: !failed,
      verdict,
      issues,
      hard: { silhouetteIoU, scaleDelta, paletteDeltaE, masks },
      signals,
      fidelity,
      spread,
      weights: WEIGHTS,
      hueZones: zones,
      hueZoneBound: HUE_ZONE_DELTA_E,
      hueZoneGate: HUE_ZONE_GATE_DELTA_E,
      interior: interiorDifference(a, b, size, options.band),
      deltaE: { mean: de.mean, p95: de.p95 },
      thresholds,
    },
    sheet: sheetOf(size, a, b, decodeHeat(heatmap, size), edgeBits),
    heatmap,
  };
}

function decodeHeat(png: Uint8Array, size: number): Uint8Array {
  const { image } = readPng(png);
  return rgbaOf(image, undefined).subarray(0, size * size * 4);
}
