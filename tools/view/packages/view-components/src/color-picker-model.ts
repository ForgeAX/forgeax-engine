export type ColorValue = readonly [number, number, number, number];
export const COLOR_PICKER_DECIMALS = 3;

export const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

export function roundColorValue(value: ColorValue): ColorValue {
  const round = (channel: number) => Number(channel.toFixed(COLOR_PICKER_DECIMALS));
  return [round(value[0]), round(value[1]), round(value[2]), round(value[3])];
}

export function toColorValue(value: readonly number[]): ColorValue {
  return [clamp01(value[0] ?? 1), clamp01(value[1] ?? 1), clamp01(value[2] ?? 1), clamp01(value[3] ?? 1)];
}

export function rgbToHsv([r, g, b]: ColorValue): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  return [(hue * 60 + 360) % 360, max ? delta / max : 0, max];
}

export function hsvToRgb(hue: number, saturation: number, value: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360 / 60;
  const chroma = clamp01(value) * clamp01(saturation);
  const secondary = chroma * (1 - Math.abs(h % 2 - 1));
  const offset = clamp01(value) - chroma;
  const sector = Math.floor(h);
  const rgb = sector === 0 ? [chroma, secondary, 0] : sector === 1 ? [secondary, chroma, 0]
    : sector === 2 ? [0, chroma, secondary] : sector === 3 ? [0, secondary, chroma]
      : sector === 4 ? [secondary, 0, chroma] : [chroma, 0, secondary];
  return [rgb[0]! + offset, rgb[1]! + offset, rgb[2]! + offset];
}

export const linearToSrgb = (value: number) => value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
export const srgbToLinear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

export function colorHex(color: ColorValue, srgb = true): string {
  return color.map((channel, index) => Math.round(clamp01(srgb && index < 3 ? linearToSrgb(channel) : channel) * 255)
    .toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function parseColorHex(text: string, srgb = true): ColorValue | null {
  const match = /^#?([\da-f]{6})([\da-f]{2})?$/i.exec(text.trim());
  if (!match) return null;
  const bytes = (match[1]! + (match[2] ?? 'FF')).match(/../g)!.map(pair => Number.parseInt(pair, 16) / 255);
  return [srgbToLinearIf(bytes[0]!, srgb), srgbToLinearIf(bytes[1]!, srgb), srgbToLinearIf(bytes[2]!, srgb), bytes[3]!];
}

function srgbToLinearIf(value: number, srgb: boolean): number { return srgb ? srgbToLinear(value) : value; }

export function previewColor(color: ColorValue, srgb = true): string {
  const channels = color.slice(0, 3).map(value => Math.round(clamp01(srgb ? linearToSrgb(value) : value) * 255));
  return `rgb(${channels.join(' ')} / ${color[3]})`;
}

export function previewGradient(direction: 'to right' | 'to top', sample: (position: number) => ColorValue, srgb: boolean): string {
  const stops = Array.from({ length: 17 }, (_, index) => {
    const position = index / 16;
    return `${previewColor(sample(position), srgb)} ${position * 100}%`;
  });
  return `linear-gradient(${direction}, ${stops.join(', ')})`;
}
