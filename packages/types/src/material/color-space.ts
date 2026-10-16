import type { MaterialValue } from './asset.js';

/** Transfer function attached to an authored material color. */
export type MaterialColorSpace = 'srgb' | 'linear';

/** Minimal schema shape needed to identify authored color values. */
export interface MaterialColorParameterSchema {
  readonly name: string;
  readonly type: string;
  readonly colorSpace?: MaterialColorSpace;
}

/** IEC 61966-2-1 sRGB electro-optical transfer function. */
export function srgbChannelToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** IEC 61966-2-1 inverse transfer function. */
export function linearChannelToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

/**
 * Decode an authored RGB/RGBA value for linear runtime use.
 *
 * Only the first three color channels are transformed. Alpha and any
 * additional lanes are data and pass through unchanged.
 */
export function authoredColorToLinear(
  value: readonly number[],
  colorSpace: MaterialColorSpace = 'srgb',
): number[] {
  if (colorSpace === 'linear') return [...value];
  return value.map((channel, index) => (index < 3 ? srgbChannelToLinear(channel) : channel));
}

/**
 * Resolve a material parameter's asset-side transfer-function contract.
 * `color` is an authored color and therefore defaults to sRGB. Numeric
 * vectors remain linear unless their schema explicitly marks them as colors.
 */
export function materialParameterColorSpace(
  parameter: MaterialColorParameterSchema,
  assetColorSpace?: MaterialColorSpace,
): MaterialColorSpace | undefined {
  const isColor = parameter.type === 'color' || parameter.colorSpace !== undefined;
  if (!isColor) return undefined;
  return assetColorSpace ?? parameter.colorSpace ?? 'srgb';
}

/**
 * Project authored MaterialAsset values into a fresh runtime value map.
 * Asset values are never mutated, so repeated extraction cannot compound the
 * transfer function.
 */
export function materialValuesToLinearRuntime(
  values: Readonly<Record<string, MaterialValue | null>> | undefined,
  parameters: readonly MaterialColorParameterSchema[],
  assetColorSpace?: MaterialColorSpace,
): Readonly<Record<string, MaterialValue | null>> {
  if (values === undefined) return {};
  const colorSpaces = new Map<string, MaterialColorSpace>();
  for (const parameter of parameters) {
    const colorSpace = materialParameterColorSpace(parameter, assetColorSpace);
    if (colorSpace !== undefined) colorSpaces.set(parameter.name, colorSpace);
  }

  const runtimeValues: Record<string, MaterialValue | null> = {};
  for (const [name, value] of Object.entries(values)) {
    const colorSpace = colorSpaces.get(name);
    runtimeValues[name] =
      colorSpace !== undefined && Array.isArray(value)
        ? authoredColorToLinear(value, colorSpace)
        : value;
  }
  return runtimeValues;
}
