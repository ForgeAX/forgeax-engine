export const THREE_R184_TONE_MODES = [
  'linear',
  'reinhard',
  'cineon',
  'aces-filmic',
  'agx',
  'neutral',
] as const;

export type ThreeR184ToneMode = (typeof THREE_R184_TONE_MODES)[number];
export type Rgb = readonly [number, number, number];

const REC2020_FROM_SRGB = [
  [0.6274, 0.3293, 0.0433],
  [0.0691, 0.9195, 0.0113],
  [0.0164, 0.088, 0.8956],
] as const;

const SRGB_FROM_REC2020 = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
] as const;

const AGX_INSET = [
  [0.856627153315983, 0.0951212405381588, 0.0482516061458583],
  [0.137318972929847, 0.761241990602591, 0.101439036467562],
  [0.11189821299995, 0.0767994186031903, 0.811302368396859],
] as const;

const AGX_OUTSET = [
  [1.1271005818144368, -0.11060664309660323, -0.016493938717834573],
  [-0.1413297634984383, 1.157823702216272, -0.016493938717834257],
  [-0.14132976349843826, -0.11060664309660294, 1.2519364065950405],
] as const;

const ACES_INPUT = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
] as const;

const ACES_OUTPUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
] as const;

function multiplyMatrix(matrix: readonly (readonly number[])[], color: Rgb): [number, number, number] {
  return [
    matrix[0]![0]! * color[0] + matrix[0]![1]! * color[1] + matrix[0]![2]! * color[2],
    matrix[1]![0]! * color[0] + matrix[1]![1]! * color[1] + matrix[1]![2]! * color[2],
    matrix[2]![0]! * color[0] + matrix[2]![1]! * color[1] + matrix[2]![2]! * color[2],
  ];
}

function mapRgb(color: Rgb, map: (channel: number) => number): [number, number, number] {
  return [map(color[0]), map(color[1]), map(color[2])];
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function mapLinear(color: Rgb, exposure: number): [number, number, number] {
  return mapRgb(color, (channel) => clamp01(channel * exposure));
}

function mapReinhard(color: Rgb, exposure: number): [number, number, number] {
  return mapRgb(color, (channel) => {
    const exposed = channel * exposure;
    return clamp01(exposed / (exposed + 1));
  });
}

function mapCineon(color: Rgb, exposure: number): [number, number, number] {
  return mapRgb(color, (channel) => {
    const x = Math.max(channel * exposure - 0.004, 0);
    return ((x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06)) ** 2.2;
  });
}

function fitAces(color: Rgb): [number, number, number] {
  return mapRgb(color, (channel) => {
    const numerator = channel * (channel + 0.0245786) - 0.000090537;
    const denominator = channel * ((channel + 0.432951) * 0.983729) + 0.238081;
    return numerator / denominator;
  });
}

function mapAcesFilmic(color: Rgb, exposure: number): [number, number, number] {
  const exposed = mapRgb(color, (channel) => (channel * exposure) / 0.6);
  return mapRgb(multiplyMatrix(ACES_OUTPUT, fitAces(multiplyMatrix(ACES_INPUT, exposed))), clamp01);
}

function agxContrast(value: number): number {
  const x2 = value * value;
  const x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * value + 31.96 * x4 - 6.868 * x2 * value + 0.4298 * x2 + 0.1191 * value - 0.00232;
}

function mapAgx(color: Rgb, exposure: number): [number, number, number] {
  let mapped = multiplyMatrix(AGX_INSET, multiplyMatrix(REC2020_FROM_SRGB, mapRgb(color, (channel) => channel * exposure)));
  mapped = mapRgb(mapped, (channel) => Math.log2(Math.max(channel, 1e-10)));
  mapped = mapRgb(mapped, (channel) => clamp01((channel + 12.47393) / (4.026069 + 12.47393)));
  mapped = mapRgb(mapped, agxContrast);
  mapped = mapRgb(multiplyMatrix(AGX_OUTSET, mapped), (channel) => Math.max(channel, 0) ** 2.2);
  return mapRgb(multiplyMatrix(SRGB_FROM_REC2020, mapped), clamp01);
}

function mapNeutral(color: Rgb, exposure: number): [number, number, number] {
  const startCompression = 0.76;
  const desaturation = 0.15;
  const exposed = mapRgb(color, (channel) => channel * exposure);
  const minimum = Math.min(...exposed);
  const offset = minimum < 0.08 ? minimum - 6.25 * minimum * minimum : 0.04;
  const adjusted = mapRgb(exposed, (channel) => channel - offset);
  const peak = Math.max(...adjusted);
  if (peak < startCompression) return adjusted;
  const distance = 1 - startCompression;
  const newPeak = 1 - (distance * distance) / (peak + distance - startCompression);
  const scaled = mapRgb(adjusted, (channel) => channel * (newPeak / peak));
  const blend = 1 - 1 / (desaturation * (peak - newPeak) + 1);
  return mapRgb(scaled, (channel) => channel * (1 - blend) + newPeak * blend);
}

export function toneMapThreeR184(mode: ThreeR184ToneMode, color: Rgb, exposure: number): [number, number, number] {
  switch (mode) {
    case 'linear':
      return mapLinear(color, exposure);
    case 'reinhard':
      return mapReinhard(color, exposure);
    case 'cineon':
      return mapCineon(color, exposure);
    case 'aces-filmic':
      return mapAcesFilmic(color, exposure);
    case 'agx':
      return mapAgx(color, exposure);
    case 'neutral':
      return mapNeutral(color, exposure);
  }
}
