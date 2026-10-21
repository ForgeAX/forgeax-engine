// Reference vectors computed with independently inverted RGB/XYZ and Bradford matrices.
// RGB/XYZ basis: https://www.w3.org/Graphics/Color/srgb
export const whiteBalanceCases = [
  {
    name: 'neutral',
    rgb: [0.125, 0.25, 0.5],
    temperature: 6504,
    tint: 0,
    exposure: 1,
    expected: [0.125, 0.25, 0.5],
  },
  {
    name: 'tint-only',
    rgb: [0.125, 0.25, 0.5],
    temperature: 6504,
    tint: 0.2,
    exposure: 1,
    expected: [0.15, 0.2, 0.6],
  },
  {
    name: 'red-negative-tint',
    rgb: [1, 0, 0],
    temperature: 6504,
    tint: -0.2,
    exposure: 1,
    expected: [0.8, 0, 0],
  },
  {
    name: 'warm',
    rgb: [0.125, 0.25, 0.5],
    temperature: 5000,
    tint: 0.2,
    exposure: 1,
    expected: [0.2065962678, 0.193473972, 0.4658717683],
  },
  {
    name: 'cool',
    rgb: [0.125, 0.25, 0.5],
    temperature: 10000,
    tint: 0,
    exposure: 1,
    expected: [0.0949390663, 0.2462123181, 0.7029296975],
  },
  {
    name: 'hdr-candidate',
    rgb: [2, 0.5, 0.125],
    temperature: 3000,
    tint: -0.1,
    exposure: 2,
    expected: [4.9856966222, 0.8489132035, -0.0371840133],
  },
] as const;
