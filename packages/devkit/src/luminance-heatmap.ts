// luminance-heatmap.ts -- compose the `dev look --view luminance` image.
//
// The live App returns one frame of pre-tonemap scene luminance as two byte
// planes (1/8-stop EV codes and bloom high-pass classes). This module turns
// them into a false-colour heat map anchored on the camera's bloom threshold:
// cool whole-stop bands below it, a hatched band for the smoothstep knee
// (threshold .. threshold + smoothWidth) and hot whole-stop bands for pixels
// at full bloom weight, plus a legend strip with the numeric settings.

/** Wire form of `simulation.observation.luminance()`. */
export interface LuminanceObservation {
  readonly frameId: number;
  readonly width: number;
  readonly height: number;
  readonly domain: 'linear-hdr';
  readonly bloom: {
    readonly enabled: boolean;
    readonly threshold: number;
    readonly smoothWidth: number;
    readonly intensity: number;
  };
  readonly encoding: { readonly evMin: number; readonly stepsPerStop: number };
  readonly stats: {
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    readonly counts: { readonly below: number; readonly knee: number; readonly above: number };
    readonly bloomFraction: number;
  };
  readonly planes: { readonly evCode: string; readonly bloomClass: string };
}

export interface HeatmapImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

type Rgb = readonly [number, number, number];

/** Whole stops below the threshold, from far (-10 and darker) to just below (-1). */
export const HEATMAP_BELOW: readonly Rgb[] = [
  [11, 11, 43],
  [26, 22, 80],
  [42, 31, 122],
  [40, 62, 158],
  [31, 95, 174],
  [27, 128, 176],
  [31, 160, 168],
  [53, 189, 143],
  [92, 205, 110],
  [150, 222, 96],
];
/** Whole stops at full bloom weight: +0, +1, +2, +3 and brighter. */
export const HEATMAP_ABOVE: readonly Rgb[] = [
  [255, 48, 32],
  [255, 138, 0],
  [255, 214, 120],
  [255, 255, 255],
];
export const HEATMAP_KNEE: readonly [Rgb, Rgb] = [
  [255, 43, 214],
  [255, 255, 255],
];
const NO_LIGHT: Rgb = [0, 0, 0];

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function evOf(code: number, observation: LuminanceObservation): number {
  return observation.encoding.evMin + (code - 1) / observation.encoding.stepsPerStop;
}

/** Colour of one pixel; knee pixels alternate along 45-degree stripes so they read as a band. */
export function heatmapColor(
  code: number,
  bloomClass: number,
  x: number,
  y: number,
  observation: LuminanceObservation,
): Rgb {
  if (bloomClass === 1) return HEATMAP_KNEE[((x + y) >> 2) & 1] as Rgb;
  if (code === 0) return NO_LIGHT;
  const ev = evOf(code, observation);
  const { threshold, smoothWidth } = observation.bloom;
  if (bloomClass === 2) {
    const base = Math.log2(Math.max(threshold + smoothWidth, 2 ** observation.encoding.evMin));
    const band = Math.max(0, Math.min(HEATMAP_ABOVE.length - 1, Math.floor(ev - base)));
    return HEATMAP_ABOVE[band] as Rgb;
  }
  const relative = threshold > 0 ? ev - Math.log2(threshold) : -HEATMAP_BELOW.length;
  const band = Math.max(-HEATMAP_BELOW.length, Math.min(-1, Math.floor(relative)));
  return HEATMAP_BELOW[HEATMAP_BELOW.length + band] as Rgb;
}

// 5x7 bitmap glyphs, one string per row ('#' = ink). Only legend characters.
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  '2': [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  '3': ['#####', '   # ', '  #  ', '   # ', '    #', '#   #', ' ### '],
  '4': ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '],
  '5': ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  '6': ['  ## ', ' #   ', '#    ', '#### ', '#   #', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  '8': [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
  '9': [' ### ', '#   #', '#   #', ' ####', '    #', '   # ', ' ##  '],
  '.': ['     ', '     ', '     ', '     ', '     ', ' ##  ', ' ##  '],
  '-': ['     ', '     ', '     ', '#####', '     ', '     ', '     '],
  '+': ['     ', '  #  ', '  #  ', '#####', '  #  ', '  #  ', '     '],
  '%': ['##   ', '##  #', '   # ', '  #  ', ' #   ', '#  ##', '   ##'],
  '(': ['   # ', '  #  ', ' #   ', ' #   ', ' #   ', '  #  ', '   # '],
  ')': [' #   ', '  #  ', '   # ', '   # ', '   # ', '  #  ', ' #   '],
  ':': ['     ', ' ##  ', ' ##  ', '     ', ' ##  ', ' ##  ', '     '],
  '=': ['     ', '     ', '#####', '     ', '#####', '     ', '     '],
  '<': ['   # ', '  #  ', ' #   ', '#    ', ' #   ', '  #  ', '   # '],
  '>': ['#    ', ' #   ', '  #  ', '   # ', '  #  ', ' #   ', '#    '],
  '|': ['  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
  C: [' ### ', '#   #', '#    ', '#    ', '#    ', '#   #', ' ### '],
  D: ['###  ', '#  # ', '#   #', '#   #', '#   #', '#  # ', '###  '],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
  F: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    '],
  G: [' ### ', '#   #', '#    ', '# ###', '#   #', '#   #', ' ####'],
  H: ['#   #', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  I: [' ### ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  K: ['#   #', '#  # ', '# #  ', '##   ', '# #  ', '#  # ', '#   #'],
  L: ['#    ', '#    ', '#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #'],
  N: ['#   #', '#   #', '##  #', '# # #', '#  ##', '#   #', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    '],
  R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
  S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '#   #', '# # #', '# # #', '# # #', ' # # '],
  X: ['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #'],
  Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '],
};
const GLYPH_ADVANCE = 6;

class Canvas {
  readonly rgba: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgba = new Uint8Array(width * height * 4);
  }

  set(x: number, y: number, color: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const offset = (y * this.width + x) * 4;
    this.rgba[offset] = color[0];
    this.rgba[offset + 1] = color[1];
    this.rgba[offset + 2] = color[2];
    this.rgba[offset + 3] = 255;
  }

  fill(
    x0: number,
    y0: number,
    width: number,
    height: number,
    color: (x: number, y: number) => Rgb,
  ) {
    for (let y = y0; y < y0 + height; y += 1)
      for (let x = x0; x < x0 + width; x += 1) this.set(x, y, color(x, y));
  }

  text(x0: number, y0: number, value: string, scale: number, color: Rgb): void {
    for (const [index, char] of [...value.toUpperCase()].entries()) {
      const glyph = GLYPHS[char];
      if (glyph === undefined) continue;
      for (const [row, bits] of glyph.entries())
        for (let column = 0; column < 5; column += 1)
          if (bits[column] === '#')
            this.fill(
              x0 + (index * GLYPH_ADVANCE + column) * scale,
              y0 + row * scale,
              scale,
              scale,
              () => color,
            );
    }
  }
}

export function textWidth(value: string, scale: number): number {
  return value.length * GLYPH_ADVANCE * scale;
}

function legendCells(
  observation: LuminanceObservation,
): { label: string; color: (x: number, y: number) => Rgb }[] {
  const below = HEATMAP_BELOW.map((color, index) => ({
    label: String(index - HEATMAP_BELOW.length),
    color: () => color,
  }));
  const knee = {
    label: 'KNEE',
    color: (x: number, y: number) => heatmapColor(1, 1, x, y, observation),
  };
  const above = HEATMAP_ABOVE.map((color, index) => ({
    label: index === HEATMAP_ABOVE.length - 1 ? `+${index}+` : `+${index}`,
    color: () => color,
  }));
  return [...below, knee, ...above];
}

function formatLuminance(value: number): string {
  if (value === 0) return '0';
  return value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toPrecision(2);
}

function percent(part: number, observation: LuminanceObservation): string {
  const total = observation.width * observation.height;
  return `${total === 0 ? '0.0' : ((100 * part) / total).toFixed(1)}%`;
}

/** The two legend text lines, also returned in the look JSON for non-visual readers. */
export function legendLines(observation: LuminanceObservation): readonly [string, string] {
  const { bloom, stats } = observation;
  const thresholdEv = bloom.threshold > 0 ? Math.log2(bloom.threshold).toFixed(2) : '-';
  const maxEv = stats.max > 0 ? Math.log2(stats.max).toFixed(1) : '-';
  return [
    `STOPS VS THRESHOLD ${formatLuminance(bloom.threshold)} (EV ${thresholdEv}) KNEE +${formatLuminance(bloom.smoothWidth)} BLOOM ${bloom.enabled ? 'ON' : 'OFF'}`,
    `MAX ${formatLuminance(stats.max)} (EV ${maxEv}) MEAN ${formatLuminance(stats.mean)} | KNEE ${percent(stats.counts.knee, observation)} FULL ${percent(stats.counts.above, observation)}`,
  ];
}

/** Compose the heat map and its legend strip as one RGBA image. */
export function renderLuminanceHeatmap(observation: LuminanceObservation): HeatmapImage {
  const { width, height } = observation;
  const codes = decodeBase64(observation.planes.evCode);
  const classes = decodeBase64(observation.planes.bloomClass);
  if (codes.length !== width * height || classes.length !== width * height)
    throw new Error('live-look-luminance-invalid: plane sizes do not match the frame extent');
  const scale = width >= 960 ? 2 : 1;
  const cellHeight = 11 * scale;
  const lineHeight = 10 * scale;
  const legendHeight = cellHeight + 2 * lineHeight + 4 * scale;
  const canvas = new Canvas(width, height + legendHeight);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      canvas.set(
        x,
        y,
        heatmapColor(codes[index] as number, classes[index] as number, x, y, observation),
      );
    }
  canvas.fill(0, height, width, legendHeight, () => [24, 24, 28]);
  const cells = legendCells(observation);
  const cellWidth = Math.floor(width / cells.length);
  for (const [index, cell] of cells.entries()) {
    const x0 = index * cellWidth;
    canvas.fill(x0, height, cellWidth - 1, cellHeight, cell.color);
    const labelX = x0 + Math.max(0, Math.floor((cellWidth - textWidth(cell.label, scale)) / 2));
    const ink: Rgb = index < 6 ? [255, 255, 255] : [0, 0, 0];
    canvas.text(labelX, height + 2 * scale, cell.label, scale, ink);
  }
  const lines = legendLines(observation);
  for (const [index, line] of lines.entries())
    canvas.text(
      2 * scale,
      height + cellHeight + 2 * scale + index * lineHeight,
      line,
      scale,
      [230, 230, 230],
    );
  return { width, height: height + legendHeight, rgba: canvas.rgba };
}
