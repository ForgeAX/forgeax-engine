import type { RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../../gpu-texture-usage';

export const CLOUD_MODE0_BLUE_NOISE = 'cloud-mode0-blue-noise';
const WIDTH = 128;
const SLICES = 64;
const SLICE_LENGTH = WIDTH * WIDTH;
const HEIGHT = WIDTH * SLICES;

/** Original scalar field. Remove low frequencies in XY and T, then rank each slice to uniform R8. */
export function createCloudMode0BlueNoisePixels() {
  const white = new Uint8Array(WIDTH * HEIGHT);
  let seed = 0x5ac7aac5;
  for (let index = 0; index < white.length; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    white[index] = seed >>> 24;
  }

  const spatial = new Int16Array(white.length);
  const mask = WIDTH - 1;
  for (let frame = 0; frame < SLICES; frame++) {
    const start = frame * SLICE_LENGTH;
    for (let y = 0; y < WIDTH; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const index = start + y * WIDTH + x;
        const left = start + y * WIDTH + ((x - 1) & mask);
        const right = start + y * WIDTH + ((x + 1) & mask);
        const above = start + ((y - 1) & mask) * WIDTH + x;
        const below = start + ((y + 1) & mask) * WIDTH + x;
        spatial[index] =
          4 * (white[index] ?? 0) -
          (white[left] ?? 0) -
          (white[right] ?? 0) -
          (white[above] ?? 0) -
          (white[below] ?? 0);
      }
    }
  }

  const result = new Uint8Array(white.length);
  const score = new Int16Array(SLICE_LENGTH);
  const rank = new Uint16Array(SLICE_LENGTH);
  // Filter the eight-frame cycles independently because Mode 0 wraps at frame 8.
  for (let frame = 0; frame < SLICES; frame++) {
    const cycle = frame & ~7;
    const start = frame * SLICE_LENGTH;
    const previous = (cycle + ((frame - 1) & 7)) * SLICE_LENGTH;
    const next = (cycle + ((frame + 1) & 7)) * SLICE_LENGTH;
    for (let index = 0; index < SLICE_LENGTH; index++) {
      score[index] =
        2 * (spatial[start + index] ?? 0) -
        (spatial[previous + index] ?? 0) -
        (spatial[next + index] ?? 0);
      rank[index] = index;
    }
    rank.sort(
      (a, b) =>
        (score[a] ?? 0) - (score[b] ?? 0) || (white[start + a] ?? 0) - (white[start + b] ?? 0),
    );
    for (let index = 0; index < SLICE_LENGTH; index++) {
      result[start + (rank[index] ?? 0)] = index >>> 6;
    }
  }
  return result;
}

/** One immutable, linear R8 input per device generation. */
export function createCloudMode0BlueNoise(device: RhiDevice) {
  const size = { width: WIDTH, height: HEIGHT };
  const texture = device.createTexture({
    label: CLOUD_MODE0_BLUE_NOISE,
    size,
    format: 'r8unorm',
    usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST,
    textureBindingViewDimension: '2d',
  });
  if (!texture.ok) return texture;
  const uploaded = device.queue.writeTexture(
    { texture: texture.value },
    createCloudMode0BlueNoisePixels(),
    { bytesPerRow: WIDTH, rowsPerImage: HEIGHT },
    size,
  );
  if (!uploaded.ok) {
    device.destroyTexture(texture.value);
    return uploaded;
  }
  const view = device.createTextureView(texture.value, {
    label: `${CLOUD_MODE0_BLUE_NOISE}.view`,
    dimension: '2d',
  });
  if (!view.ok) {
    device.destroyTexture(texture.value);
    return view;
  }
  return ok({ texture: texture.value, view: view.value });
}
