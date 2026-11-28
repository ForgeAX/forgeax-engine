import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { halfFloat } from '@forgeax/engine/math';
import { encodePng } from '@forgeax/engine-image/png';
import { nubisInstanceGuid, nubisInstanceSource } from '../assets/nubis/clouds.pack.ts';
import { DAWN_LAYOUT_METERS, DAWN_ROLES, DAWN_SEED } from '../assets/nubis/dawn-textures.ts';

import { bakeCloudTextures } from '../assets/nubis/gpu-bake.ts';
import { nubisGpuRecipe } from '../assets/nubis/nubis-gpu.ts';

const SHA256 = data => createHash('sha256').update(data).digest('hex');

const SLOT_BY_ROLE = {
  'layout-pattern': 'layoutPattern',
  'layout-mask': 'layoutMask',
  'height-profile': 'heightProfile',
  'body-noise': 'bodyNoise',
};

const CHANNEL_DESCRIPTIONS = {
  'layout-pattern': [
    'R: mid-low sleek sweeping thin-sheet ribbons (orthogonal (1,2)/(-2,1) basis)',
    'G: mid-high feathered cirrus ribbons (rotated (1,3)/(-3,1) basis)',
    'B: high-altitude gossamer cirrus trails (rotated (2,3)/(-3,2) basis)',
    'A: unused (0)',
  ],
  'layout-mask': [
    'R: half-tile-compensated sparse sheet-spine modulation (0 outside pattern support)',
    'G: half-tile-compensated sparse cirrus-spine modulation (0 outside pattern support)',
    'B: half-tile-compensated sparse upper-trail modulation (0 outside pattern support)',
    'A: unused (0)',
  ],
  'height-profile': [
    'R: mid-low flattened deck profile (center h=0.25..0.29, peak 0.568, maxStepH<=0.0052)',
    'G: mid-high feathered deck profile (center h=0.39..0.426, peak 0.562, maxStepH<=0.0050)',
    'B: high gossamer deck profile (center h=0.54..0.572, peak 0.556, maxStepH<=0.0047)',
    'A: unused (0)',
  ],
  'body-noise': [
    'R: vigorous horizontal wind-combed coordinate warp (60x,60x,75x) shredding sheet edges',
    'G: curl-bent diagonal wispy 3D volume carrier (4.167x,4.444x,9.091x; no box blur)',
    'B: high-contrast organic wispy detail erosion (30x,40x,25x when useDetail=true)',
    'A: fine micro-cellular detail',
  ],
};

// Map logical [R, G, B, A] index to raw byte lane for bgra8unorm ([B, G, R, A]).
const BGRA_OFFSET = [2, 1, 0, 3];

function readChannel(texture, pixelIndex, channel) {
  if (texture.format === 'rgba16float') {
    return halfFloat.f16ToF32(texture.half.getUint16((pixelIndex * 4 + channel) * 2, true));
  }
  return texture.data[pixelIndex * 4 + BGRA_OFFSET[channel]] / 255;
}

const toByte = value => Math.round(255 * Math.max(0, Math.min(1, value)));

function render2DAtlas(texture, gain = 1) {
  const { width, height } = texture.shape.extent;
  const panelW = Math.min(width, 512);
  const panelH = Math.min(height, 512);
  const stepX = width / panelW;
  const stepY = height / panelH;
  const outW = panelW * 2;
  const outH = panelH * 2;
  const pixels = new Uint8Array(outW * outH * 4);

  const writePanel = (panelCol, panelRow, mode) => {
    const ox = panelCol * panelW;
    const oy = panelRow * panelH;
    for (let y = 0; y < panelH; y++) {
      const sy = Math.min(height - 1, Math.floor(y * stepY));
      for (let x = 0; x < panelW; x++) {
        const sx = Math.min(width - 1, Math.floor(x * stepX));
        const src = sx + width * sy;
        const dst = ((ox + x) + (oy + y) * outW) * 4;
        if (mode === 'rgb') {
          pixels[dst + 0] = toByte(readChannel(texture, src, 0) * gain);
          pixels[dst + 1] = toByte(readChannel(texture, src, 1) * gain);
          pixels[dst + 2] = toByte(readChannel(texture, src, 2) * gain);
        } else {
          const gray = toByte(readChannel(texture, src, mode) * gain);
          pixels[dst + 0] = gray;
          pixels[dst + 1] = gray;
          pixels[dst + 2] = gray;
        }
        pixels[dst + 3] = 255;
      }
    }
  };

  writePanel(0, 0, 'rgb');
  writePanel(1, 0, 0);
  writePanel(0, 1, 1);
  writePanel(1, 1, 2);
  return { png: encodePng(outW, outH, pixels), layout: { width: outW, height: outH, panels: ['top-left: RGB', 'top-right: R', 'bottom-left: G', 'bottom-right: B'], gain } };
}

function render3DAtlas(texture) {
  const { width, height, depth } = texture.shape.extent;
  const midZ = Math.floor(depth / 2);
  const midY = Math.floor(height / 2);
  const outW = width * 4;
  const outH = height * 2;
  const pixels = new Uint8Array(outW * outH * 4);

  for (let ch = 0; ch < 4; ch++) {
    const ox = ch * width;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcXY = x + width * (y + height * midZ);
        const dstXY = ((ox + x) + y * outW) * 4;
        const vXY = toByte(readChannel(texture, srcXY, ch));
        pixels[dstXY + 0] = vXY;
        pixels[dstXY + 1] = vXY;
        pixels[dstXY + 2] = vXY;
        pixels[dstXY + 3] = 255;

        // Bottom row: XZ vertical cross-section (z runs bottom-to-top visually so low altitude is at bottom).
        const z = depth - 1 - y;
        const srcXZ = x + width * (midY + height * z);
        const dstXZ = ((ox + x) + (height + y) * outW) * 4;
        const vXZ = toByte(readChannel(texture, srcXZ, ch));
        pixels[dstXZ + 0] = vXZ;
        pixels[dstXZ + 1] = vXZ;
        pixels[dstXZ + 2] = vXZ;
        pixels[dstXZ + 3] = 255;
      }
    }
  }
  return {
    png: encodePng(outW, outH, pixels),
    layout: {
      width: outW,
      height: outH,
      topRow: `XY horizontal slice at z=${midZ}/${depth} [R, G, B, A]`,
      bottomRow: `XZ vertical cross-section at y=${midY}/${height} (altitude bottom-to-top) [R, G, B, A]`,
    },
  };
}

const directory = resolve(process.argv[2] ?? 'artifacts/dawn-textures');
await mkdir(directory, { recursive: true });
const instanceSource = nubisInstanceSource('nubis-dawn');
const manifest = {
  asset: 'nubis-dawn',
  displayName: 'Morning Sheet Clouds',
  bake: 'hardware-webgpu',
  materialInstanceGuid: nubisInstanceGuid('nubis-dawn'),
  parentMaterialGuid: instanceSource.material,
  seed: DAWN_SEED,
  seedHex: `0x${DAWN_SEED.toString(16)}`,
  authoredTileMeters: DAWN_LAYOUT_METERS,
  profileAxes: 'U (left->right) = normalized cloud height h in [0,1]; V (top->bottom) = encoded layout strength in [0,1] (V=0 and V=1 neutral wrap zero rows)',
  textures: {},
};

const baked = await bakeCloudTextures(Object.fromEntries(DAWN_ROLES.map(role => [role, nubisGpuRecipe('nubis-dawn', role)])));
for (const role of DAWN_ROLES) {
  const { data, kind, format, colorSpace, shape, mips } = baked[role];
  const raw = `${role}.raw`;
  const png = `${role}.png`;
  const half = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rendered = role === 'body-noise'
    ? render3DAtlas({ data, format, shape, half })
    : render2DAtlas({ data, format, shape, half }, role === 'layout-mask' ? 4 : 1);
  await Promise.all([
    writeFile(join(directory, raw), data),
    writeFile(join(directory, png), rendered.png),
  ]);
  manifest.textures[role] = {
    slot: SLOT_BY_ROLE[role],
    guid: instanceSource.overrides[SLOT_BY_ROLE[role]],
    kind,
    format,
    colorSpace,
    shape,
    mips,
    channels: CHANNEL_DESCRIPTIONS[role],
    raw,
    preview: png,
    previewLayout: rendered.layout,
    sha256: SHA256(data),
    bytes: data.byteLength,
  };
}

await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(directory);
