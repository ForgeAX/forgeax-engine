/**
 * Automatic visual report for one composed game frame (`forgeax dev look`).
 * Pure pixel statistics over sRGB-encoded RGBA8 and heuristic findings that tell
 * an agent what to look at; they never replace opening the PNG.
 */

export interface LookRegionMetrics {
  /** Mean Rec. 709 luma of the encoded pixels, 0-255. */
  readonly luma: number;
  /** Mean HSV saturation, 0-1. */
  readonly saturation: number;
}

export interface LookMetrics extends LookRegionMetrics {
  readonly width: number;
  readonly height: number;
  /** RMS contrast: standard deviation of luma, 0-255. */
  readonly contrast: number;
  /** Share of pixels with luma >= 250 (blown highlights), 0-1. */
  readonly clipped: number;
  /** Share of pixels with luma <= 5 (crushed shadows), 0-1. */
  readonly crushed: number;
  /** The centre box (middle half of each axis), where a framed subject usually sits. */
  readonly centre: LookRegionMetrics;
  /** Everything outside the centre box. */
  readonly surround: LookRegionMetrics;
  /** One flat colour: nothing rendered, or a full-screen overlay. */
  readonly flat: boolean;
}

/** Thresholds behind each finding; heuristic, tuned on judged daylight and night frames. */
export const LOOK_THRESHOLDS = {
  flatContrast: 2,
  dark: 60,
  bright: 205,
  lowSaturation: 0.22,
  lowContrast: 28,
  clipped: 0.03,
  crushed: 0.1,
  separationLuma: 8,
  separationSaturation: 0.03,
} as const;

interface Accumulator {
  count: number;
  luma: number;
  lumaSquares: number;
  saturation: number;
  clipped: number;
  crushed: number;
}

function accumulator(): Accumulator {
  return { count: 0, luma: 0, lumaSquares: 0, saturation: 0, clipped: 0, crushed: 0 };
}

function addPixel(target: Accumulator, red: number, green: number, blue: number): void {
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const max = Math.max(red, green, blue);
  target.count += 1;
  target.luma += luma;
  target.lumaSquares += luma * luma;
  target.saturation += max === 0 ? 0 : (max - Math.min(red, green, blue)) / max;
  if (luma >= 250) target.clipped += 1;
  if (luma <= 5) target.crushed += 1;
}

function region(value: Accumulator): LookRegionMetrics {
  const count = Math.max(1, value.count);
  return { luma: round(value.luma / count, 1), saturation: round(value.saturation / count, 3) };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Summarize an RGBA8 frame; alpha is ignored because a composed screenshot is opaque. */
export function summarizeLook(rgba: Uint8Array, width: number, height: number): LookMetrics {
  const centre = accumulator();
  const surround = accumulator();
  const x0 = Math.floor(width / 4);
  const x1 = Math.ceil((width * 3) / 4);
  const y0 = Math.floor(height / 4);
  const y1 = Math.ceil((height * 3) / 4);
  for (let y = 0; y < height; y++) {
    const inRows = y >= y0 && y < y1;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const target = inRows && x >= x0 && x < x1 ? centre : surround;
      addPixel(target, rgba[offset] ?? 0, rgba[offset + 1] ?? 0, rgba[offset + 2] ?? 0);
    }
  }
  const count = Math.max(1, centre.count + surround.count);
  const luma = (centre.luma + surround.luma) / count;
  const variance = Math.max(0, (centre.lumaSquares + surround.lumaSquares) / count - luma * luma);
  const contrast = Math.sqrt(variance);
  return {
    width,
    height,
    luma: round(luma, 1),
    saturation: round((centre.saturation + surround.saturation) / count, 3),
    contrast: round(contrast, 1),
    clipped: round((centre.clipped + surround.clipped) / count, 4),
    crushed: round((centre.crushed + surround.crushed) / count, 4),
    centre: region(centre),
    surround: region(surround),
    flat: contrast < LOOK_THRESHOLDS.flatContrast,
  };
}

function percent(value: number): string {
  return `${round(value * 100, 1)}%`;
}

function exposureFindings(metrics: LookMetrics): string[] {
  const t = LOOK_THRESHOLDS;
  const findings: string[] = [];
  if (metrics.luma < t.dark)
    findings.push(
      `dark: mean luma ${metrics.luma} < ${t.dark}; right for night only if lit pools keep the subject readable`,
    );
  if (metrics.luma > t.bright)
    findings.push(`very bright: mean luma ${metrics.luma} > ${t.bright}; check exposure and fog`);
  if (metrics.clipped > t.clipped)
    findings.push(`blown highlights: ${percent(metrics.clipped)} of pixels are near white`);
  if (metrics.crushed > t.crushed)
    findings.push(`crushed shadows: ${percent(metrics.crushed)} of pixels are near black`);
  return findings;
}

function colourFindings(metrics: LookMetrics): string[] {
  const t = LOOK_THRESHOLDS;
  const findings: string[] = [];
  if (metrics.saturation < t.lowSaturation)
    findings.push(
      `low saturation: ${metrics.saturation} < ${t.lowSaturation}; the frame reads grey or washed out (fog over the subject, a cool Skylight fill, AgX)`,
    );
  if (metrics.contrast < t.lowContrast)
    findings.push(`low contrast: luma deviation ${metrics.contrast} < ${t.lowContrast}`);
  const lumaGap = Math.abs(metrics.centre.luma - metrics.surround.luma);
  const saturationGap = Math.abs(metrics.centre.saturation - metrics.surround.saturation);
  if (lumaGap < t.separationLuma && saturationGap < t.separationSaturation)
    findings.push(
      `weak subject separation: the centre differs from its surround by ${round(lumaGap, 1)} luma and ${round(saturationGap, 3)} saturation`,
    );
  return findings;
}

/**
 * Findings in priority order. A renderer error or flat frame makes the pixel
 * statistics meaningless, so it is the only finding reported.
 */
export function lookFindings(
  metrics: LookMetrics,
  rendererError: { readonly code?: unknown } | null | undefined,
): readonly string[] {
  if (rendererError != null)
    return [
      `renderer error ${String(rendererError.code ?? 'unknown')}: the frame is not the scene; repair it first`,
    ];
  if (metrics.flat)
    return ['flat frame: one colour, so nothing rendered or an overlay covers the canvas'];
  return [...exposureFindings(metrics), ...colourFindings(metrics)];
}
