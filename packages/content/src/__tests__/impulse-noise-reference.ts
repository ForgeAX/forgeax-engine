import { linearChannelToSrgb } from '@forgeax/engine-types';

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const fade = (value: number) => value * value * value * (value * (value * 6 - 15) + 10);

function hash(x: number, y: number, seed: number): number {
  let value = Math.imul(x, 1597334677) ^ Math.imul(y, 3812015801) ^ seed;
  value = Math.imul(value ^ (value >>> 16), 2246822507);
  value = Math.imul(value ^ (value >>> 13), 3266489909);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
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
  period: number,
  seed: number,
  amplitude: number,
): void {
  const indices = new Uint32Array(size);
  const fades = new Float64Array(size);
  for (let index = 0; index < size; index++) {
    const coordinate = (index / size) * period;
    const integer = Math.floor(coordinate);
    indices[index] = integer % period;
    fades[index] = fade(coordinate - integer);
  }
  const stride = period + 1;
  const plane = new Float64Array(stride * stride);
  for (let y = 0; y <= period; y++)
    for (let x = 0; x <= period; x++) plane[y * stride + x] = hash(x % period, y % period, seed);
  const rows = interpolatedRows(size, plane, period, indices, fades);
  for (let y = 0; y < size; y++) {
    const row = (indices[y] as number) * size;
    const fy = fades[y] as number;
    for (let x = 0; x < size; x++) {
      const a = rows[row + x] as number;
      const b = rows[row + size + x] as number;
      const pixel = y * size + x;
      data[pixel] = (data[pixel] as number) + amplitude * (a + (b - a) * fy);
    }
  }
}

function fieldPixels(size: number): Float64Array {
  const data = new Float64Array(size * size);
  let amplitude = 1;
  let weight = 0;
  let period = 6;
  for (let octave = 0; octave < 5; octave++, period *= 2, amplitude *= 0.5) {
    addGridLayer(size, data, period, 13217 + octave * 1013, amplitude);
    weight += amplitude;
  }
  for (let index = 0; index < data.length; index++) data[index] = (data[index] as number) / weight;
  return data;
}

export function waterImpulseSourcePixels(): Uint8Array {
  const field = fieldPixels(256);
  let sum = 0;
  let squared = 0;
  for (let index = 0; index < field.length; index++) {
    const value = clamp(0.5 + ((field[index] as number) - 0.5) * 1.8) * 255;
    field[index] = value;
    sum += value;
    squared += value ** 2;
  }
  const mean = sum / field.length;
  const deviation = Math.sqrt(Math.max(0, squared / field.length - mean ** 2)) || 1;
  const pixels = new Uint8Array(field.length);
  for (let index = 0; index < field.length; index++)
    pixels[index] = Math.round(
      Math.max(0, Math.min(255, 120.89 + (((field[index] as number) - mean) * 60.8) / deviation)),
    );
  return pixels;
}

const SIZE = 256;

function sharpen4Kernel(): Float32Array {
  const blur = (source: Float32Array) =>
    Float32Array.from(
      source,
      (_, index) =>
        ((source[index - 1] ?? 0) + (source[index] as number) + (source[index + 1] ?? 0)) / 3,
    );
  const positive = new Float32Array(8);
  const negative = new Float32Array(8);
  positive[3] = positive[4] = 1.3;
  negative[3] = negative[4] = -0.8;
  const sharpened = blur(positive);
  const gaussian = blur(blur(blur(negative)));
  return Float32Array.from(sharpened, (value, index) => value + (gaussian[index] as number));
}

/** Gamma 2.2 source decode, value exponent 1.2 and an eight-tap sharpened mip pyramid. */
export function impulseNoiseLevels(source: Uint8Array): readonly Float32Array[] {
  const levels: Float32Array[] = [
    Float32Array.from(
      { length: SIZE * SIZE },
      (_, index) => Math.fround(((source[index] as number) / 255) ** 2.2) ** Math.fround(1.2),
    ),
  ];
  const kernel = sharpen4Kernel();
  let average = levels[0] as Float32Array;
  for (let width = SIZE; width > 1; width /= 2) {
    const nextWidth = width / 2;
    const output = new Float32Array(nextWidth * nextWidth);
    const nextAverage = new Float32Array(output.length);
    for (let y = 0; y < nextWidth; y++)
      for (let x = 0; x < nextWidth; x++) {
        let value = 0;
        for (let ky = 0; ky < 8; ky++)
          for (let kx = 0; kx < 8; kx++) {
            const sx = (x * 2 + kx - 3) & (width - 1);
            const sy = (y * 2 + ky - 3) & (width - 1);
            value +=
              (average[sy * width + sx] as number) *
              (kernel[kx] as number) *
              (kernel[ky] as number);
          }
        output[y * nextWidth + x] = value;
        const origin = y * 2 * width + x * 2;
        nextAverage[y * nextWidth + x] =
          ((average[origin] as number) +
            (average[origin + 1] as number) +
            (average[origin + width] as number) +
            (average[origin + width + 1] as number)) *
          0.25;
      }
    levels.push(output);
    // The average pyramid prevents sharpening from accumulating between levels.
    average = nextAverage;
  }
  return levels;
}

export function impulseNoiseReference(): Uint8Array {
  const levels = impulseNoiseLevels(waterImpulseSourcePixels());
  const data = new Uint8Array(levels.reduce((count, level) => count + level.length * 4, 0));
  let offset = 0;
  for (const level of levels)
    for (const linear of level) {
      const encoded = Math.round(linearChannelToSrgb(Math.max(0, Math.min(linear, 1))) * 255);
      data.set([encoded, encoded, encoded, 255], offset);
      offset += 4;
    }
  return data;
}
