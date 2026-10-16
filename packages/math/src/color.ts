// color.ts — RGBA color namespace (M5 / T-032)
//
// Surface: create / clone / srgbToLinear / linearToSrgb / fromHex / fromCss / toHex, plus the
// primaries-derived RGB gamut SSOT (RGB_PRIMARIES / rgbGamutMatrix / Display-P3 conversions)
//
// Design anchors:
//   - branded Float32Array length 4 [r, g, b, a]; `as Color` casts are funneled inside factories (D-P15)
//   - sRGB ↔ linear: IEC 61966-2-1 piecewise gamma; RGB channels only, alpha pass-through
//     - srgbToLinear: cutoff 0.04045 / linear segment v/12.92 / power segment ((v+0.055)/1.055)^2.4
//     - linearToSrgb: cutoff 0.0031308 / linear segment 12.92*v / power segment 1.055*v^(1/2.4) - 0.055
//     - negatives / NaN returned verbatim (HDR-friendly + IEEE-754 NaN propagation)
//   - fromHex (D-P7): only `#RRGGBB` (7 chars) and `#RRGGBBAA` (9 chars); RGB channels are decoded
//     from sRGB to linear; illegal inputs silently fall
//     back to (0, 0, 0, 1) without throwing (D-P12 degenerate family / AC-06)
//     - #RGB / #RGBA short forms are not supported (stricter than bevy_color::Srgba::hex; less ambiguous
//       in practice; wiki/sources/2026-05-05-bevy-0-19-math-transform-color §Srgba::hex mentions short
//       forms but D-P7 actively tightens the contract)
//   - fromCss: deterministic CSS color boundary for full hex plus common rgb()/rgba()/hsl()/hsla()
//     and named colors; output is linear and illegal inputs use the same black fallback
//   - toHex: alpha=1 → `#rrggbb`; alpha<1 → `#rrggbbaa`; linear components are encoded to sRGB,
//     clamped to [0, 1], multiplied by 255 and rounded; output is lowercase
//
// Related: requirements §Surface color lower bound 6 + AC-06 silent fall-back (never raises);
//          plan-strategy D-P7 / D-P12 / §appendix A degenerate registry #14-#16;
//          wiki/sources/2026-05-05-bevy-0-19-math-transform-color §sRGB piecewise gamma;
//          wiki/glam-rs-overview §LinearRgba.

import type { Color, ColorLike } from './types';

export type { Color, ColorLike };

// === create / copy ===

/** Create a Color (default RGBA = (0, 0, 0, 1) = opaque black). */
export function create(r = 0, g = 0, b = 0, a = 1): Color {
  return Float32Array.of(r, g, b, a) as Color;
}

/** Allocate a new Color copy. */
export function clone(c: ColorLike): Color {
  return Float32Array.of(c[0] as number, c[1] as number, c[2] as number, c[3] as number) as Color;
}

// === sRGB ↔ linear (IEC 61966-2-1 piecewise gamma) ===

/**
 * Single-channel sRGB → linear (component-level helper).
 *
 * @degrade NaN input → NaN output (IEEE-754 arithmetic propagation); negatives returned verbatim
 * to preserve HDR / specialized rendering needs (same convention as bevy_color::gamma_function;
 * wiki/sources bevy-0-19-color §gamma_function).
 *
 * @example
 * ```ts
 * srgbChannelToLinear(NaN);  // → NaN (IEEE-754 propagation)
 * srgbChannelToLinear(-0.1); // → -0.1 (HDR / negative kept verbatim)
 * ```
 */
function srgbChannelToLinear(v: number): number {
  if (Number.isNaN(v)) return Number.NaN;
  if (v <= 0) return v;
  if (v <= 0.04045) return v / 12.92;
  return ((v + 0.055) / 1.055) ** 2.4;
}

/** Single-channel linear → sRGB (component-level helper). */
function linearChannelToSrgb(v: number): number {
  if (Number.isNaN(v)) return Number.NaN;
  if (v <= 0) return v;
  if (v <= 0.0031308) return v * 12.92;
  return 1.055 * v ** (1 / 2.4) - 0.055;
}

/**
 * out = sRGB → linear conversion (RGB channels only; alpha passed through).
 *
 * @degrade NaN propagation / negatives returned verbatim (HDR-friendly); alpha is strictly untouched.
 *
 * @example
 * ```ts
 * color.srgbToLinear(out, color.create(NaN, -0.1, 0.5, 0.8));
 * // → out = (NaN, -0.1, ~0.214, 0.8); alpha 0.8 passed through unchanged.
 * ```
 */
export function srgbToLinear(out: Color, c: ColorLike): Color {
  out[0] = srgbChannelToLinear(c[0] as number);
  out[1] = srgbChannelToLinear(c[1] as number);
  out[2] = srgbChannelToLinear(c[2] as number);
  out[3] = c[3] as number;
  return out;
}

/**
 * out = linear → sRGB conversion (RGB channels only; alpha passed through).
 *
 * @degrade NaN propagation / negatives returned verbatim; alpha is strictly untouched.
 *
 * @example
 * ```ts
 * color.linearToSrgb(out, color.create(NaN, -0.05, 0.5, 1));
 * // → out = (NaN, -0.05, ~0.735, 1); alpha is strictly untouched.
 * ```
 */
export function linearToSrgb(out: Color, c: ColorLike): Color {
  out[0] = linearChannelToSrgb(c[0] as number);
  out[1] = linearChannelToSrgb(c[1] as number);
  out[2] = linearChannelToSrgb(c[2] as number);
  out[3] = c[3] as number;
  return out;
}

// === RGB gamut (primaries -> 3x3 conversion) ===

/** Closed set of RGB colour spaces the engine converts between. Both share D65 and the sRGB transfer curve. */
export type RgbColorSpace = 'srgb' | 'display-p3';

/** CIE 1931 xy chromaticities of one RGB colour space. */
export interface RgbPrimaries {
  readonly red: readonly [number, number];
  readonly green: readonly [number, number];
  readonly blue: readonly [number, number];
  readonly white: readonly [number, number];
}

/** CIE 1931 xy of the D65 white point (IEC 61966-2-1 / SMPTE EG 432-1). */
export const D65_WHITE_XY: readonly [number, number] = Object.freeze([0.3127, 0.329] as const);

/**
 * Primaries SSOT. Rec.709/sRGB per IEC 61966-2-1; Display P3 is DCI-P3
 * primaries with the D65 white point (SMPTE EG 432-1). Every gamut matrix in
 * TS and the generated WGSL block derives from these numbers.
 */
export const RGB_PRIMARIES: Readonly<Record<RgbColorSpace, RgbPrimaries>> = Object.freeze({
  srgb: Object.freeze({
    red: [0.64, 0.33],
    green: [0.3, 0.6],
    blue: [0.15, 0.06],
    white: D65_WHITE_XY,
  } as const),
  'display-p3': Object.freeze({
    red: [0.68, 0.32],
    green: [0.265, 0.69],
    blue: [0.15, 0.06],
    white: D65_WHITE_XY,
  } as const),
});

/** Row-major 3x3 matrix in float64: `out = M * rgb`. */
export type RgbMatrix3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

function xyToXyz(xy: readonly [number, number]): [number, number, number] {
  return [xy[0] / xy[1], 1, (1 - xy[0] - xy[1]) / xy[1]];
}

function multiply3(a: RgbMatrix3, b: RgbMatrix3): RgbMatrix3 {
  const out: number[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += (a[row * 3 + k] as number) * (b[k * 3 + col] as number);
      out.push(sum);
    }
  }
  return out as unknown as RgbMatrix3;
}

function invert3(m: RgbMatrix3): RgbMatrix3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

/**
 * Derive the linear RGB -> CIE XYZ matrix from xy primaries (SMPTE RP 177):
 * columns are the primaries' XYZ scaled so RGB (1, 1, 1) maps to the white
 * point with Y = 1.
 */
export function rgbToXyzMatrix(primaries: RgbPrimaries): RgbMatrix3 {
  const r = xyToXyz(primaries.red);
  const g = xyToXyz(primaries.green);
  const b = xyToXyz(primaries.blue);
  const w = xyToXyz(primaries.white);
  const inverse = invert3([r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]]);
  const s = [
    inverse[0] * w[0] + inverse[1] * w[1] + inverse[2] * w[2],
    inverse[3] * w[0] + inverse[4] * w[1] + inverse[5] * w[2],
    inverse[6] * w[0] + inverse[7] * w[1] + inverse[8] * w[2],
  ] as const;
  return [
    r[0] * s[0],
    g[0] * s[1],
    b[0] * s[2],
    r[1] * s[0],
    g[1] * s[1],
    b[1] * s[2],
    r[2] * s[0],
    g[2] * s[1],
    b[2] * s[2],
  ];
}

/** Linear RGB `from` -> linear RGB `to` (same white point, so no adaptation). */
export function rgbGamutMatrix(from: RgbColorSpace, to: RgbColorSpace): RgbMatrix3 {
  return multiply3(invert3(rgbToXyzMatrix(RGB_PRIMARIES[to])), rgbToXyzMatrix(RGB_PRIMARIES[from]));
}

/** Linear Rec.709/sRGB -> linear Display P3, derived from {@link RGB_PRIMARIES}. */
export const LINEAR_SRGB_TO_LINEAR_DISPLAY_P3: RgbMatrix3 = Object.freeze(
  rgbGamutMatrix('srgb', 'display-p3'),
);

/** Linear Display P3 -> linear Rec.709/sRGB; components outside sRGB become negative or > 1. */
export const LINEAR_DISPLAY_P3_TO_LINEAR_SRGB: RgbMatrix3 = Object.freeze(
  rgbGamutMatrix('display-p3', 'srgb'),
);

function applyMatrix(out: Color, m: RgbMatrix3, c: ColorLike): Color {
  const r = c[0] as number;
  const g = c[1] as number;
  const b = c[2] as number;
  out[0] = m[0] * r + m[1] * g + m[2] * b;
  out[1] = m[3] * r + m[4] * g + m[5] * b;
  out[2] = m[6] * r + m[7] * g + m[8] * b;
  out[3] = c[3] as number;
  return out;
}

/** out = linear sRGB -> linear Display P3 (alpha passed through, no clamping). */
export function linearSrgbToLinearDisplayP3(out: Color, c: ColorLike): Color {
  return applyMatrix(out, LINEAR_SRGB_TO_LINEAR_DISPLAY_P3, c);
}

/** out = linear Display P3 -> linear sRGB (alpha passed through; out-of-sRGB colours keep negatives). */
export function linearDisplayP3ToLinearSrgb(out: Color, c: ColorLike): Color {
  return applyMatrix(out, LINEAR_DISPLAY_P3_TO_LINEAR_SRGB, c);
}

/**
 * out = CSS `color(display-p3 r g b)` (sRGB transfer curve, P3 primaries) ->
 * linear Rec.709 working colour. Colours outside sRGB keep negative components
 * so a Display-P3 output can reproduce them.
 */
export function displayP3ToLinear(out: Color, c: ColorLike): Color {
  return linearDisplayP3ToLinearSrgb(out, srgbToLinear(out, c));
}

// === Hex parse / serialize ===

const HEX_PATTERN = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})?$/;

/**
 * Write a Color from a hex string.
 *
 * Only supports the two forms `#RRGGBB` (7 chars) and `#RRGGBBAA` (9 chars) (D-P7);
 * the CSS-style `#RGB` / `#RGBA` short forms are not supported.
 *
 * @degrade Any illegal input (short form / non-hex chars / missing # / wrong length / empty string,
 * etc.) silently falls back to (0, 0, 0, 1); never throws (D-P12 / AC-06).
 *
 * @example
 * ```ts
 * color.fromHex(out, '#ff8000');   // → (1, ~0.216, 0, 1)
 * color.fromHex(out, '#ff800080'); // → (1, ~0.216, 0, 0.502)
 * color.fromHex(out, '#fff');      // → (0, 0, 0, 1) short form unsupported → silent fall-back
 * ```
 */
export function fromHex(out: Color, hex: string): Color {
  const match = typeof hex === 'string' ? HEX_PATTERN.exec(hex) : null;
  if (match === null) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    return out;
  }
  out[0] = srgbChannelToLinear(Number.parseInt(match[1] as string, 16) / 255);
  out[1] = srgbChannelToLinear(Number.parseInt(match[2] as string, 16) / 255);
  out[2] = srgbChannelToLinear(Number.parseInt(match[3] as string, 16) / 255);
  out[3] = match[4] !== undefined ? Number.parseInt(match[4], 16) / 255 : 1;
  return out;
}

const CSS_HEX_PATTERN = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const CSS_RGB_PATTERN = /^rgba?\(([^()]*)\)$/i;
const CSS_HSL_PATTERN = /^hsla?\(([^()]*)\)$/i;
const CSS_DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

const CSS_NAMED_COLORS: Readonly<Record<string, string>> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  fuchsia: '#ff00ff',
  gray: '#808080',
  green: '#008000',
  grey: '#808080',
  lime: '#00ff00',
  magenta: '#ff00ff',
  maroon: '#800000',
  navy: '#000080',
  olive: '#808000',
  orange: '#ffa500',
  purple: '#800080',
  red: '#ff0000',
  silver: '#c0c0c0',
  teal: '#008080',
  transparent: '#00000000',
  white: '#ffffff',
  yellow: '#ffff00',
};

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function parseCssChannel(token: string): number | undefined {
  const trimmed = token.trim();
  if (trimmed.endsWith('%')) {
    const raw = trimmed.slice(0, -1).trim();
    if (!CSS_DECIMAL_PATTERN.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? clamp01(value / 100) : undefined;
  }
  if (!CSS_DECIMAL_PATTERN.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? clamp01(value / 255) : undefined;
}

function parseCssAlpha(token: string): number | undefined {
  const trimmed = token.trim();
  if (trimmed.endsWith('%')) {
    const raw = trimmed.slice(0, -1).trim();
    if (!CSS_DECIMAL_PATTERN.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? clamp01(value / 100) : undefined;
  }
  if (!CSS_DECIMAL_PATTERN.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? clamp01(value) : undefined;
}

function parseCssHue(token: string): number | undefined {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)?$/i.exec(token.trim());
  if (match === null) return undefined;
  const raw = Number(match[1] as string);
  if (!Number.isFinite(raw)) return undefined;
  const unit = (match[2] ?? 'deg').toLowerCase();
  const degrees =
    unit === 'grad'
      ? raw * 0.9
      : unit === 'rad'
        ? (raw * 180) / Math.PI
        : unit === 'turn'
          ? raw * 360
          : raw;
  return ((degrees % 360) + 360) % 360;
}

function parseCssPercentage(token: string): number | undefined {
  const trimmed = token.trim();
  if (!trimmed.endsWith('%')) return undefined;
  const raw = trimmed.slice(0, -1).trim();
  if (!CSS_DECIMAL_PATTERN.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? clamp01(value / 100) : undefined;
}

function splitCssColorArgs(
  body: string,
): { channels: [string, string, string]; alpha?: string } | undefined {
  const source = body.trim();
  if (source.length === 0) return undefined;
  if (source.includes(',')) {
    if (source.includes('/')) return undefined;
    const parts = source.split(',').map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) return undefined;
    if (parts.some((part) => part.length === 0)) return undefined;
    return {
      channels: [parts[0] as string, parts[1] as string, parts[2] as string],
      ...(parts.length === 4 ? { alpha: parts[3] as string } : {}),
    };
  }
  const tokens = source.replaceAll('/', ' / ').split(/\s+/);
  const slash = tokens.indexOf('/');
  if (slash === -1) {
    if (tokens.length !== 3) return undefined;
    return { channels: [tokens[0] as string, tokens[1] as string, tokens[2] as string] };
  }
  if (slash !== 3 || tokens.length !== 5 || tokens[4] === undefined) return undefined;
  return {
    channels: [tokens[0] as string, tokens[1] as string, tokens[2] as string],
    alpha: tokens[4],
  };
}

function hslToSrgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const h = hue / 60;
  const x = chroma * (1 - Math.abs((h % 2) - 1));
  const [r1, g1, b1] =
    h < 1
      ? [chroma, x, 0]
      : h < 2
        ? [x, chroma, 0]
        : h < 3
          ? [0, chroma, x]
          : h < 4
            ? [0, x, chroma]
            : h < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = lightness - chroma / 2;
  return [r1 + m, g1 + m, b1 + m];
}

function cssFallback(out: Color): Color {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 1;
  return out;
}

/**
 * Write a Color from a deterministic CSS color string.
 *
 * Supports full and short hex, common named colors, rgb()/rgba() channel
 * numbers or percentages, and hsl()/hsla() with an optional alpha. RGB
 * channels are decoded to linear-sRGB; alpha is passed through unchanged.
 * Unsupported or malformed input silently falls back to opaque black.
 */
export function fromCss(out: Color, css: string): Color {
  if (typeof css !== 'string') return cssFallback(out);
  const source = css.trim().toLowerCase();
  const named = CSS_NAMED_COLORS[source];
  if (named !== undefined) return fromHex(out, named);
  const fullHex = CSS_HEX_PATTERN.exec(source);
  if (fullHex !== null) {
    const digits = fullHex[1] as string;
    if (digits.length === 3 || digits.length === 4) {
      const expanded = [...digits].map((channel) => `${channel}${channel}`).join('');
      return fromHex(out, `#${expanded}`);
    }
    return fromHex(out, source);
  }

  const rgb = CSS_RGB_PATTERN.exec(source);
  if (rgb !== null) {
    const args = splitCssColorArgs(rgb[1] as string);
    if (args === undefined) return cssFallback(out);
    const r = parseCssChannel(args.channels[0]);
    const g = parseCssChannel(args.channels[1]);
    const b = parseCssChannel(args.channels[2]);
    const alpha = args.alpha === undefined ? 1 : parseCssAlpha(args.alpha);
    if (r === undefined || g === undefined || b === undefined || alpha === undefined)
      return cssFallback(out);
    out[0] = srgbChannelToLinear(r);
    out[1] = srgbChannelToLinear(g);
    out[2] = srgbChannelToLinear(b);
    out[3] = alpha;
    return out;
  }

  const hsl = CSS_HSL_PATTERN.exec(source);
  if (hsl !== null) {
    const args = splitCssColorArgs(hsl[1] as string);
    if (args === undefined) return cssFallback(out);
    const hue = parseCssHue(args.channels[0]);
    const saturation = parseCssPercentage(args.channels[1]);
    const lightness = parseCssPercentage(args.channels[2]);
    const alpha = args.alpha === undefined ? 1 : parseCssAlpha(args.alpha);
    if (
      hue === undefined ||
      saturation === undefined ||
      lightness === undefined ||
      alpha === undefined
    )
      return cssFallback(out);
    const [r, g, b] = hslToSrgb(hue, saturation, lightness);
    out[0] = srgbChannelToLinear(r);
    out[1] = srgbChannelToLinear(g);
    out[2] = srgbChannelToLinear(b);
    out[3] = alpha;
    return out;
  }
  return cssFallback(out);
}

/** Encode one linear component to sRGB, then clamp + ×255 + round. */
function toHexByte(v: number, encodeLinear = true): string {
  if (Number.isNaN(v)) return '00';
  const clamped = Math.max(0, Math.min(1, encodeLinear ? linearChannelToSrgb(v) : v));
  const byte = Math.round(clamped * 255);
  return byte.toString(16).padStart(2, '0');
}

/**
 * Serialize as hex string: alpha=1 → `#rrggbb`; alpha<1 → `#rrggbbaa`.
 *
 * @degrade Out-of-range components (HDR > 1 / negatives) are clamped to [0, 1] then rounded;
 * **truncated** rather than throwing (symmetric with fromHex's silent fall-back). NaN components →
 * literal '00' (same byte as 0.0; prevents the hex-string builder from throwing; alpha=NaN takes the
 * alpha=1 path, emitting the short `#rrggbb` form).
 *
 * @example
 * ```ts
 * color.toHex(color.create(2, -0.1, 0.5, 1));    // → '#ff00bc' (linear HDR/negative clamp)
 * color.toHex(color.create(1, 0, 0, 0.5));        // → '#ff000080'
 * color.toHex(color.create(NaN, 0, 0, NaN));      // → '#000000' (NaN→'00', alpha=NaN takes short form)
 * ```
 */
export function toHex(c: ColorLike): string {
  const r = toHexByte(c[0] as number);
  const g = toHexByte(c[1] as number);
  const b = toHexByte(c[2] as number);
  const aValue = c[3] as number;
  if (aValue >= 1 || Number.isNaN(aValue)) {
    return `#${r}${g}${b}`;
  }
  const a = toHexByte(aValue, false);
  return `#${r}${g}${b}${a}`;
}
