import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { encodePng } from '@forgeax/engine-image/png';
import { alpineTextureGuid } from '../assets/nubis/alpine.pack.ts';
import { ALPINE_LAYOUT_METERS, ALPINE_ROLES, ALPINE_SEED, makeAlpineTexture } from '../assets/nubis/alpine-textures.ts';

const SHA256 = data => createHash('sha256').update(data).digest('hex');
const channels = {
  'layout-pattern': ['stratus bands', 'middle cumulus', 'tower cumulus', 'unused'],
  'layout-mask': ['cumulus core', 'cumulus core', 'cumulus core', 'unused'],
  'height-profile': ['stratus profile', 'middle cumulus profile', 'tower profile', 'unused'],
  'body-noise': ['position warp', 'volume and large folds', 'fine erosion', 'diagnostic crannies'],
};

function readPixel(texture, pixel, channel) {
  if (texture.format === 'rgba16float') return texture.half.getFloat16(8 * pixel + 2 * channel, true);
  return texture.data[4 * pixel + channel] / 255;
}

function preview(role, texture) {
  const { width, height } = texture.shape.extent;
  const volume = role === 'body-noise';
  const atlasSize = volume ? 2 : 1;
  const pixels = new Uint8Array(width * height * atlasSize ** 2 * 4);
  const slice = volume ? Math.floor(texture.shape.extent.depth / 2) : 0;
  const gain = 1;
  for (let y = 0; y < height * atlasSize; y++) for (let x = 0; x < width * atlasSize; x++) {
    const pixel = (x % width) + width * ((y % height) + height * slice);
    const fileOffset = (x + y * width * atlasSize) * 4;
    const volumeLane = Math.floor(x / width) + 2 * Math.floor(y / height);
    for (let c = 0; c < 3; c++) {
      const value = readPixel(texture, pixel, volume ? volumeLane : c);
      pixels[fileOffset + c] = Math.round(255 * Math.max(0, Math.min(1, value * gain)));
    }
    pixels[fileOffset + 3] = 255;
  }
  return encodePng(width * atlasSize, height * atlasSize, pixels);
}

const directory = resolve(process.argv[2] ?? 'artifacts/alpine-valley-textures');
await mkdir(directory, { recursive: true });
const manifest = {
  asset: 'alpine-valley', seed: ALPINE_SEED, authoredTileMeters: ALPINE_LAYOUT_METERS, textures: {},
};
for (const role of ALPINE_ROLES) {
  const { data, kind, format, colorSpace, shape, mips } = makeAlpineTexture(role);
  const raw = `${role}.raw`, png = `${role}.png`;
  const half = new DataView(data.buffer, data.byteOffset, data.byteLength);
  await Promise.all([
    writeFile(join(directory, raw), data),
    writeFile(join(directory, png), preview(role, { data, format, shape, half })),
  ]);
  manifest.textures[role] = { guid: alpineTextureGuid(role), kind, format, colorSpace, shape, mips,
    channels: channels[role], raw, preview: png, sha256: SHA256(data), bytes: data.byteLength };
}
await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(directory);
