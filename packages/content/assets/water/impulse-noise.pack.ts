import { definePack } from '@forgeax/engine-pack/source';
import { err, ok, sha256Bytes, type TextureAsset } from '@forgeax/engine-types';
import { linearToSrgb } from '../checker.pack.ts';
import { CONTENT_PACKAGE_IDS, CONTENT_SOURCE_KEYS, contentGuid } from '../../src/ids.ts';

const SIZE = 256;
const SOURCE_RGBA_SHA256 = 'f772cc13d0f252cb8875c8145ae840737dda1071ba3dc9d2cbd41fa33385a3f9';

function sharpen4Kernel(): Float32Array {
  const blur = (source: Float32Array) => Float32Array.from(source, (_, index) =>
    ((source[index - 1] ?? 0) + source[index]! + (source[index + 1] ?? 0)) / 3);
  const positive = new Float32Array(8);
  const negative = new Float32Array(8);
  positive[3] = positive[4] = 1.3;
  negative[3] = negative[4] = -.8;
  const sharpened = blur(positive);
  const gaussian = blur(blur(blur(negative)));
  return Float32Array.from(sharpened, (value, index) => value + gaussian[index]!);
}

/** Legacy Pow22 source decode, HSV Value curve 1.2, then the Sharpen4/average pyramid. */
export function impulseNoiseLevels(source: Uint8Array): readonly Float32Array[] {
  const levels: Float32Array[] = [Float32Array.from({ length: SIZE * SIZE }, (_, index) =>
    Math.pow(Math.fround(Math.pow(source[index * 4]! / 255, 2.2)), Math.fround(1.2)))];
  const kernel = sharpen4Kernel();
  let average = levels[0]!;
  for (let width = SIZE; width > 1; width /= 2) {
    const nextWidth = width / 2;
    const output = new Float32Array(nextWidth * nextWidth);
    const nextAverage = new Float32Array(output.length);
    for (let y = 0; y < nextWidth; y++) for (let x = 0; x < nextWidth; x++) {
      let value = 0;
      for (let ky = 0; ky < 8; ky++) for (let kx = 0; kx < 8; kx++) {
        const sx = (x * 2 + kx - 3) & (width - 1);
        const sy = (y * 2 + ky - 3) & (width - 1);
        value += average[sy * width + sx]! * kernel[kx]! * kernel[ky]!;
      }
      output[y * nextWidth + x] = value;
      const origin = y * 2 * width + x * 2;
      nextAverage[y * nextWidth + x] = (average[origin]! + average[origin + 1]!
        + average[origin + width]! + average[origin + width + 1]!) * .25;
    }
    levels.push(output);
    // UE filters each level from its separate average pyramid, not the sharpened output.
    average = nextAverage;
  }
  return levels;
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: CONTENT_PACKAGE_IDS.waterImpulse,
  name: 'Engine Content / Default Fluid Impulse Noise',
  async build({ readByGuid }) {
    const source = await readByGuid<TextureAsset>(contentGuid(CONTENT_PACKAGE_IDS.textures, CONTENT_SOURCE_KEYS.waterImpulseNoiseSource));
    if (!source.ok) return source;
    const texture = source.value;
    if (texture.kind !== 'texture' || texture.shape.viewDimension !== '2d'
      || texture.shape.extent.width !== SIZE || texture.shape.extent.height !== SIZE
      || texture.format !== 'rgba8unorm' || texture.colorSpace !== 'linear'
      || texture.mips.kind !== 'none' || texture.encoding !== undefined
      || sha256Bytes(texture.data) !== SOURCE_RGBA_SHA256)
      return err({ code: 'water-impulse-noise-source-invalid' as const,
        expected: 'the verified lossless RGBA8 256x256 T_Noise01 source pixels without importer gamma or mips',
        hint: 'restore T_Noise01.png and its linear/no-mip source Meta; see provenance.json' });
    const levels = impulseNoiseLevels(texture.data);
    const data = new Uint8Array(levels.reduce((count, level) => count + level.length * 4, 0));
    let offset = 0;
    for (const level of levels) for (const linear of level) {
      const encoded = Math.round(linearToSrgb(Math.max(0, Math.min(linear, 1))) * 255);
      data.set([encoded, encoded, encoded, 255], offset);
      offset += 4;
    }
    return ok({ [CONTENT_SOURCE_KEYS.waterTexture('impulse-noise')]: {
      kind: 'texture', shape: { viewDimension: '2d', extent: { width: SIZE, height: SIZE } },
      format: 'rgba8unorm-srgb', colorSpace: 'srgb', data, mips: { kind: 'packed', levelCount: levels.length },
    } satisfies TextureAsset });
  },
});
