// SPDX-License-Identifier: Apache-2.0
import type { TextureAsset } from '@forgeax/engine-types';

type Distribution = readonly [mean: number, deviation: number];
type Distributions = readonly [Distribution, Distribution, Distribution, Distribution];
export type WaterSurfaceTextureName =
  | 'normal'
  | 'river-diffuse'
  | 'river-normal'
  | 'foam'
  | 'foam-normal'
  | 'noise';

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const byte = (value: number) => Math.round(clamp(value) * 255);
const fade = (value: number) => value * value * value * (value * (value * 6 - 15) + 10);

function hash(x: number, y: number, z: number, seed: number): number {
  let value = Math.imul(x, 1597334677) ^ Math.imul(y, 3812015801) ^ Math.imul(z, 958689923) ^ seed;
  value = Math.imul(value ^ (value >>> 16), 2246822507);
  value = Math.imul(value ^ (value >>> 13), 3266489909);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

interface FieldWarp {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly strengthX: number;
  readonly strengthY: number;
}

interface NoiseLayer {
  readonly lower: Float64Array;
  readonly upper: Float64Array;
  readonly fz: number;
  readonly period: number;
}

function warpedCoordinates(size: number, warp: FieldWarp): Pick<FieldWarp, 'x' | 'y'> {
  const x = new Float64Array(size * size),
    y = new Float64Array(size * size);
  for (let row = 0; row < size; row++)
    for (let column = 0; column < size; column++) {
      const index = row * size + column;
      x[index] = column / size + ((warp.x[index] as number) - 0.5) * warp.strengthX;
      y[index] = row / size + ((warp.y[index] as number) - 0.5) * warp.strengthY;
    }
  return { x, y };
}

function interpolatedRows(
  size: number,
  plane: Float64Array,
  period: number,
  indices: Uint32Array,
  fades: Float64Array,
): Float64Array {
  const stride = period + 1,
    rows = new Float64Array(stride * size);
  for (let y = 0; y <= period; y++)
    for (let x = 0; x < size; x++) {
      const index = y * stride + (indices[x] as number);
      const a = plane[index] as number,
        b = plane[index + 1] as number;
      rows[y * size + x] = a + (b - a) * (fades[x] as number);
    }
  return rows;
}

function addGridLayer(
  size: number,
  data: Float64Array,
  layer: NoiseLayer,
  amplitude: number,
): void {
  const { lower, upper, fz, period } = layer;
  const indices = new Uint32Array(size),
    fades = new Float64Array(size);
  for (let index = 0; index < size; index++) {
    const coordinate = (index / size) * period,
      integer = Math.floor(coordinate);
    indices[index] = integer % period;
    fades[index] = fade(coordinate - integer);
  }
  // Reuse X interpolation without changing the X-then-Y-then-Z arithmetic order.
  const lowerRows = interpolatedRows(size, lower, period, indices, fades);
  if (fz === 0) {
    for (let y = 0; y < size; y++) {
      const row = (indices[y] as number) * size,
        fy = fades[y] as number;
      for (let x = 0; x < size; x++) {
        const a = lowerRows[row + x] as number,
          b = lowerRows[row + size + x] as number;
        const pixel = y * size + x;
        data[pixel] = (data[pixel] as number) + amplitude * (a + (b - a) * fy);
      }
    }
    return;
  }
  const upperRows = interpolatedRows(size, upper, period, indices, fades);
  for (let y = 0; y < size; y++) {
    const row = (indices[y] as number) * size,
      fy = fades[y] as number;
    for (let x = 0; x < size; x++) {
      const a = lowerRows[row + x] as number,
        b = lowerRows[row + size + x] as number;
      const c = upperRows[row + x] as number,
        d = upperRows[row + size + x] as number;
      const low = a + (b - a) * fy,
        high = c + (d - c) * fy;
      const pixel = y * size + x;
      data[pixel] = (data[pixel] as number) + amplitude * (low + (high - low) * fz);
    }
  }
}

function addWarpedPlane(
  data: Float64Array,
  layer: NoiseLayer,
  amplitude: number,
  coordinates: Pick<FieldWarp, 'x' | 'y'>,
): void {
  const { lower, period } = layer,
    stride = period + 1;
  for (let pixel = 0; pixel < data.length; pixel++) {
    const u = (coordinates.x[pixel] as number) * period;
    const v = (coordinates.y[pixel] as number) * period;
    const ix = Math.floor(u),
      iy = Math.floor(v),
      tx = u - ix,
      ty = v - iy;
    const fx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
    const fy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
    // Authored warp strengths are below one tile, so adding one period makes indices nonnegative.
    const index = ((iy + period) % period) * stride + ((ix + period) % period);
    const a = lower[index] as number,
      b = lower[index + 1] as number;
    const c = lower[index + stride] as number,
      d = lower[index + stride + 1] as number;
    const ab = a + (b - a) * fx,
      cd = c + (d - c) * fx;
    data[pixel] = (data[pixel] as number) + amplitude * (ab + (cd - ab) * fy);
  }
}

function addWarpedSlice(
  data: Float64Array,
  layer: NoiseLayer,
  amplitude: number,
  coordinates: Pick<FieldWarp, 'x' | 'y'>,
): void {
  const { lower, upper, fz, period } = layer,
    stride = period + 1;
  for (let pixel = 0; pixel < data.length; pixel++) {
    const u = (coordinates.x[pixel] as number) * period;
    const v = (coordinates.y[pixel] as number) * period;
    const ix = Math.floor(u),
      iy = Math.floor(v),
      tx = u - ix,
      ty = v - iy;
    const fx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
    const fy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
    const index = ((iy + period) % period) * stride + ((ix + period) % period);
    const a = lower[index] as number,
      b = lower[index + 1] as number;
    const c = lower[index + stride] as number,
      d = lower[index + stride + 1] as number;
    const ab = a + (b - a) * fx,
      cd = c + (d - c) * fx;
    const low = ab + (cd - ab) * fy;
    const e = upper[index] as number,
      f = upper[index + 1] as number;
    const g = upper[index + stride] as number,
      h = upper[index + stride + 1] as number;
    const ef = e + (f - e) * fx,
      gh = g + (h - g) * fx;
    const value = low + (ef + (gh - ef) * fy - low) * fz;
    data[pixel] = (data[pixel] as number) + amplitude * value;
  }
}

function fieldPixels(
  size: number,
  w: number,
  seed: number,
  octaves: number,
  start: number,
  warp?: FieldWarp,
): Float64Array {
  const data = new Float64Array(size * size);
  const coordinates = warp ? warpedCoordinates(size, warp) : undefined;
  let amplitude = 1,
    weight = 0,
    period = start;
  // Accumulate each texel's octaves in order; lattice planes and grid axes are shared within one octave.
  for (let octave = 0; octave < octaves; octave++, period *= 2, amplitude *= 0.5) {
    const z = w * period,
      iz = Math.floor(z),
      fz = fade(z - iz),
      stride = period + 1;
    const lower = new Float64Array(stride * stride),
      upper = new Float64Array(stride * stride);
    const lowerZ = ((iz % period) + period) % period,
      upperZ = (((iz + 1) % period) + period) % period;
    for (let y = 0; y <= period; y++)
      for (let x = 0; x <= period; x++) {
        const index = y * stride + x;
        lower[index] = hash(x % period, y % period, lowerZ, seed + octave * 1013);
        if (fz !== 0) upper[index] = hash(x % period, y % period, upperZ, seed + octave * 1013);
      }
    const layer = { lower, upper, fz, period };
    if (coordinates) {
      if (fz === 0) addWarpedPlane(data, layer, amplitude, coordinates);
      else addWarpedSlice(data, layer, amplitude, coordinates);
    } else addGridLayer(size, data, layer, amplitude);
    weight += amplitude;
  }
  for (let index = 0; index < data.length; index++) data[index] = (data[index] as number) / weight;
  return data;
}

function normalSurface(size: number, scalar: Float64Array, strength: number): Float64Array {
  const data = new Float64Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4,
        value = scalar[y * size + x] as number;
      const dx =
        ((scalar[y * size + ((x + 1) % size)] as number) -
          (scalar[y * size + ((x + size - 1) % size)] as number)) *
        strength;
      const dy =
        ((scalar[((y + 1) % size) * size + x] as number) -
          (scalar[((y + size - 1) % size) * size + x] as number)) *
        strength;
      const length = Math.hypot(dx, dy, 1);
      data[index] = 255 * (0.5 - (dx / length) * 0.5);
      data[index + 1] = 255 * (0.5 - (dy / length) * 0.5);
      data[index + 2] = 255 * (0.5 + 0.5 / length);
      data[index + 3] = 255 * value;
    }
  return data;
}

function calibratedPixels(
  source: Float64Array | Uint8Array,
  distributions: Distributions,
): Uint8Array {
  const output = new Uint8Array(source.length);
  for (let channel = 0; channel < 4; channel++) {
    let sum = 0,
      squared = 0;
    for (let i = channel; i < source.length; i += 4) {
      const value = source[i] as number;
      sum += value;
      squared += value ** 2;
    }
    const count = source.length / 4,
      mean = sum / count;
    const deviation = Math.sqrt(Math.max(0, squared / count - mean ** 2));
    const [targetMean, targetDeviation] = distributions[channel] as Distribution;
    for (let i = channel; i < source.length; i += 4)
      output[i] = Math.round(
        Math.max(
          0,
          Math.min(
            255,
            targetMean + (((source[i] as number) - mean) * targetDeviation) / (deviation || 1),
          ),
        ),
      );
  }
  return output;
}

function grayscalePixels(
  source: Float64Array | Uint8Array,
  distributions: Distributions,
  scale = 255,
  valueAlpha = false,
): Uint8Array {
  let sum = 0,
    squared = 0;
  for (let index = 0; index < source.length; index++) {
    const value = (source[index] as number) * scale;
    sum += value;
    squared += value ** 2;
  }
  const mean = sum / source.length;
  const deviation = Math.sqrt(Math.max(0, squared / source.length - mean ** 2)) || 1;
  const [red, green, blue, alpha] = distributions;
  const output = new Uint8Array(source.length * 4);
  for (let index = 0; index < source.length; index++) {
    const difference = (source[index] as number) * scale - mean,
      offset = index * 4;
    output[offset] = Math.round(
      Math.max(0, Math.min(255, red[0] + (difference * red[1]) / deviation)),
    );
    output[offset + 1] = Math.round(
      Math.max(0, Math.min(255, green[0] + (difference * green[1]) / deviation)),
    );
    output[offset + 2] = Math.round(
      Math.max(0, Math.min(255, blue[0] + (difference * blue[1]) / deviation)),
    );
    output[offset + 3] = 255;
  }
  if (valueAlpha)
    for (let index = 0; index < source.length; index++) {
      const difference = (source[index] as number) * scale - mean;
      output[index * 4 + 3] = Math.round(
        Math.max(0, Math.min(255, alpha[0] + (difference * alpha[1]) / deviation)),
      );
    }
  return output;
}

function tangentNormalPixels(data: Uint8Array): Uint8Array {
  for (let index = 0; index < data.length; index += 4) {
    let x = (data[index] as number) / 127.5 - 1,
      y = (data[index + 1] as number) / 127.5 - 1;
    const squared = x * x + y * y;
    if (squared > 1) {
      // Leave room for the maximum RG rounding error at the unit-circle boundary.
      const scale = (1 - Math.SQRT2 / 255) / Math.sqrt(squared);
      data[index] = byte(0.5 + x * scale * 0.5);
      data[index + 1] = byte(0.5 + y * scale * 0.5);
      x = (data[index] as number) / 127.5 - 1;
      y = (data[index + 1] as number) / 127.5 - 1;
    }
    data[index + 2] = byte(0.5 + Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5);
  }
  return data;
}

function calibratedNormalPixels(
  size: number,
  scalar: Float64Array,
  strength: number,
  distributions: Distributions,
): Uint8Array {
  const xValues = new Float64Array(scalar.length),
    yValues = new Float64Array(scalar.length);
  let sumX = 0,
    sumY = 0,
    squaredX = 0,
    squaredY = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const dx =
        ((scalar[y * size + ((x + 1) % size)] as number) -
          (scalar[y * size + ((x + size - 1) % size)] as number)) *
        strength;
      const dy =
        ((scalar[((y + 1) % size) * size + x] as number) -
          (scalar[((y + size - 1) % size) * size + x] as number)) *
        strength;
      const length = Math.hypot(dx, dy, 1);
      const red = 255 * (0.5 - (dx / length) * 0.5),
        green = 255 * (0.5 - (dy / length) * 0.5);
      xValues[index] = red;
      yValues[index] = green;
      sumX += red;
      sumY += green;
      squaredX += red ** 2;
      squaredY += green ** 2;
    }
  const meanX = sumX / scalar.length,
    meanY = sumY / scalar.length;
  const deviationX = Math.sqrt(Math.max(0, squaredX / scalar.length - meanX ** 2)) || 1;
  const deviationY = Math.sqrt(Math.max(0, squaredY / scalar.length - meanY ** 2)) || 1;
  const [red, green] = distributions;
  const data = new Uint8Array(scalar.length * 4);
  // Tangent-normal reconstruction owns Z after XY quantization; alpha is opaque.
  for (let index = 0; index < scalar.length; index++) {
    const offset = index * 4;
    data[offset] = Math.round(
      Math.max(
        0,
        Math.min(255, red[0] + (((xValues[index] as number) - meanX) * red[1]) / deviationX),
      ),
    );
    data[offset + 1] = Math.round(
      Math.max(
        0,
        Math.min(255, green[0] + (((yValues[index] as number) - meanY) * green[1]) / deviationY),
      ),
    );
    data[offset + 3] = 255;
  }
  return tangentNormalPixels(data);
}

function softenedField(size: number, source: Float64Array, radius = 4): Float64Array {
  let current = source;
  const horizontal = new Float64Array(source.length);
  for (let pass = 0; pass < 2; pass++) {
    const output = new Float64Array(source.length);
    for (let y = 0; y < size; y++) {
      let sum = 0;
      for (let dx = -radius; dx <= radius; dx++)
        sum += current[y * size + ((dx + size) % size)] as number;
      for (let x = 0; x < size; x++) {
        horizontal[y * size + x] = sum / (radius * 2 + 1);
        sum +=
          (current[y * size + ((x + radius + 1) % size)] as number) -
          (current[y * size + ((x - radius + size) % size)] as number);
      }
    }
    const sums = new Float64Array(size);
    for (let dy = -radius; dy <= radius; dy++) {
      const row = ((dy + size) % size) * size;
      for (let x = 0; x < size; x++)
        sums[x] = (sums[x] as number) + (horizontal[row + x] as number);
    }
    // Advance every column's original sum sequence while reading contiguous rows.
    for (let y = 0; y < size; y++) {
      const incoming = ((y + radius + 1) % size) * size;
      const outgoing = ((y - radius + size) % size) * size;
      for (let x = 0; x < size; x++) {
        output[y * size + x] = (sums[x] as number) / (radius * 2 + 1);
        sums[x] =
          (sums[x] as number) +
          ((horizontal[incoming + x] as number) - (horizontal[outgoing + x] as number));
      }
    }
    current = output;
  }
  return current;
}

function texture2d(
  size: number,
  data: Uint8Array,
  colorSpace: 'linear' | 'srgb' = 'linear',
): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: size, height: size } },
    format: colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
    colorSpace,
    data,
    mips: { kind: 'generate' },
  };
}

function waterNormalTexture(): TextureAsset {
  const waterWarpX = fieldPixels(1024, 0, 1847, 3, 4),
    waterWarpY = fieldPixels(1024, 0.375, 2161, 3, 4);
  const waterBlue = fieldPixels(1024, 0.25, 2833, 4, 12),
    waterAlpha = fieldPixels(1024, 0.75, 2953, 4, 24);
  const water = softenedField(
    1024,
    fieldPixels(1024, 0.25, 2689, 3, 5, {
      x: waterWarpX,
      y: waterWarpY,
      strengthX: 0.12,
      strengthY: 0.12,
    }),
    3,
  );
  const waterPixels = normalSurface(1024, water, 7);
  for (let y = 0; y < 1024; y++)
    for (let x = 0; x < 1024; x++) {
      const index = (y * 1024 + x) * 4;
      waterPixels[index + 2] = (waterBlue[y * 1024 + x] as number) * 255;
      waterPixels[index + 3] = (waterAlpha[y * 1024 + x] as number) * 255;
    }
  return texture2d(
    1024,
    calibratedPixels(waterPixels, [
      [128, 64],
      [128.5, 74],
      [62, 62],
      [160.7, 44.72],
    ]),
  );
}

function riverTextures(): Readonly<
  Pick<Record<WaterSurfaceTextureName, TextureAsset>, 'river-diffuse' | 'river-normal'>
> {
  const riverBend = fieldPixels(512, 0, 3469, 3, 4);
  const river = fieldPixels(512, 0.25, 4513, 3, 16, {
    x: riverBend,
    y: riverBend,
    strengthX: 0.15,
    strengthY: 0.1,
  });
  const riverDetail = fieldPixels(512, 0.25, 4513, 4, 72, {
    x: riverBend,
    y: riverBend,
    strengthX: 0.2,
    strengthY: 0.1,
  });
  for (let index = 0; index < riverDetail.length; index++)
    riverDetail[index] = (riverDetail[index] as number) ** 2.5;
  return {
    'river-diffuse': texture2d(
      512,
      grayscalePixels(
        riverDetail,
        [
          [135.08, 26.4],
          [141.96, 27.27],
          [138.52, 30.66],
          [71.71, 48.66],
        ],
        255,
        true,
      ),
      'srgb',
    ),
    'river-normal': texture2d(
      512,
      calibratedNormalPixels(512, river, 4, [
        [126.97, 22.39],
        [126.85, 30.17],
        [248.64, 6.64],
        [255, 0],
      ]),
    ),
  };
}

function foamTextures(): Readonly<
  Pick<Record<WaterSurfaceTextureName, TextureAsset>, 'foam' | 'foam-normal'>
> {
  const foamWarpX = fieldPixels(2048, 0, 7523, 3, 4),
    foamWarpY = fieldPixels(2048, 0.375, 9733, 3, 4);
  const foam = fieldPixels(2048, 0, 11587, 7, 6, {
    x: foamWarpX,
    y: foamWarpY,
    strengthX: 0.25,
    strengthY: 0.25,
  });
  const foamDetail = fieldPixels(2048, 0.25, 12101, 4, 48, {
    x: foamWarpX,
    y: foamWarpY,
    strengthX: 0.4,
    strengthY: 0.4,
  });
  for (let index = 0; index < foam.length; index++) {
    const warped = foam[index] as number,
      detail = (foamDetail[index] as number) - 0.5;
    foam[index] = clamp(
      warped ** 0.6 * 0.85 + (1 - Math.abs(warped * 2 - 1)) * 0.15 + detail * 0.5,
    );
  }
  return {
    foam: texture2d(
      2048,
      grayscalePixels(foam, [
        [176.87, 40.48],
        [176.88, 40.48],
        [176.87, 40.48],
        [255, 0],
      ]),
      'srgb',
    ),
    'foam-normal': texture2d(
      2048,
      calibratedNormalPixels(2048, softenedField(2048, foam, 8), 9, [
        [127.51, 17.28],
        [127.51, 16.36],
        [252.76, 3.03],
        [255, 0],
      ]),
    ),
  };
}

/** Seeded periodic fields and wrapped derivatives produce ordinary Pack texture pixels. */
export function createWaterSurfaceTextures(): Readonly<
  Record<WaterSurfaceTextureName, TextureAsset>
> {
  return {
    normal: waterNormalTexture(),
    ...riverTextures(),
    ...foamTextures(),
    noise: texture2d(
      64,
      grayscalePixels(fieldPixels(64, 0, 10949, 3, 6), [
        [142.35, 29.61],
        [142.35, 29.61],
        [142.35, 29.61],
        [255, 0],
      ]),
    ),
  };
}

export function waterImpulseSourcePixels(): Uint8Array {
  const impulse = fieldPixels(256, 0, 13217, 5, 6);
  for (let index = 0; index < impulse.length; index++)
    impulse[index] = clamp(0.5 + ((impulse[index] as number) - 0.5) * 1.8);
  return grayscalePixels(impulse, [
    [120.89, 60.8],
    [120.89, 60.8],
    [120.89, 60.8],
    [255, 0],
  ]);
}

export function waterVolumePixels(): Uint8Array {
  const volume = new Uint8Array(128 ** 3);
  for (let z = 0; z < 128; z++) {
    const pixels = fieldPixels(128, z / 128, 15331, 3, 16);
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const value = byte(pixels[y * 128 + x] as number);
        const index = (z * 128 + y) * 128 + x;
        volume[index] = value;
      }
  }
  return grayscalePixels(
    volume,
    [
      [226.41, 11.63],
      [226.41, 11.63],
      [226.41, 11.63],
      [255, 0],
    ],
    1,
  );
}
