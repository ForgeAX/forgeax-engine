import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mipChain, model, sel, type StandardMaterialOptions, type TextureSink } from '@forgeax/engine-modeling';
import type { MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CASE_FOV, createCaseRenderer, type Rgb } from '../../case/render';
import { LOW_NORMALS, UV_ATLAS } from '../asset';
import { CLIP_FRAMES, FIRE_CYCLE } from '../clip';
import { fitView, meshPositions, TURRET_AMBIENT } from '../frame';
import { turretRig } from '../rig';

/**
 * C-600 turret rig clip: the baked low turret on the rig, one Dawn frame per named pose of the fire
 * cycle on one fixed camera, plus a strip. Reads the maps written by case/bake.mts and case/compose.mts;
 * skipped without them. With FORGEAX_CASE_OUT set it writes the 1600x1200 frames and strip.png.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const MAPS = process.env.FORGEAX_C4_MAPS ?? '/tmp/c4-turret-asset/out/maps';
const WORK = process.env.FORGEAX_C4_WORK ?? '/tmp/c4-turret-asset/work';
const READY = existsSync(join(MAPS, 'albedo.rgba'));
const WIDTH = OUT === undefined ? 320 : 1600;
const HEIGHT = OUT === undefined ? 240 : 1200;
const SIZE = UV_ATLAS.resolution;
const CLEAR: [number, number, number, number] = [0.1095, 0.1195, 0.1413, 1];
const DIRECTION = [0.56, 0.42, 0.71];
const raw = (name: string) => new Uint8Array(readFileSync(join(MAPS, `${name}.rgba`)));

/** The Pack publication of the case renderer serializes every texture as JSON text, so a render keeps a few maps at `drop` levels below the atlas. */
function texture(data: Uint8Array, layout: 'normal' | 'ormh' | 'color', srgb: boolean, drop: number): TextureAsset {
  const level: TextureAsset = {
    kind: 'texture',
    format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
    colorSpace: srgb ? 'srgb' : 'linear',
    shape: { viewDimension: '2d', extent: { width: SIZE, height: SIZE } },
    mips: { kind: 'none' },
    data,
  };
  const chain = mipChain(level, { layout });
  if (!chain.ok) throw chain.error;
  const rest = chain.value.levels.slice(drop);
  const packed = new Uint8Array(rest.reduce((n, l) => n + l.byteLength, 0));
  let at = 0;
  for (const l of rest) {
    packed.set(l, at);
    at += l.byteLength;
  }
  const size = SIZE >> drop;
  return { ...level, shape: { viewDimension: '2d', extent: { width: size, height: size } }, mips: { kind: 'packed', levelCount: rest.length }, data: packed };
}

/** Box-filter a PNG down by an integer factor. */
function shrink(png: PNG, factor: number): PNG {
  const out = new PNG({ width: png.width / factor, height: png.height / factor });
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = 0; k < factor * factor; k++) sum += png.data[((y * factor + Math.floor(k / factor)) * png.width + x * factor + (k % factor)) * 4 + c] as number;
        out.data[(y * out.width + x) * 4 + c] = Math.round(sum / (factor * factor));
      }
    }
  }
  return out;
}

describe.skipIf(!READY)('C-600 turret rig clip (Dawn)', () => {
  it('renders the fire cycle frames and the strip', { timeout: 3600000 }, async () => {
    const low = model({ budget: { work: 4e9 } });
    low.append(new Uint8Array(readFileSync(join(WORK, 'low-uv.fxem'))));
    low.assign(sel.all(), 'baked');
    const rig = turretRig(low);
    const posed = CLIP_FRAMES.map((f) => {
      const pose = rig.sample(FIRE_CYCLE, f.u);
      if (!pose.ok) throw pose.error;
      const out = rig.toMesh(pose.value, { normals: LOW_NORMALS });
      if (!out.ok) throw out.error;
      return { name: f.name, mesh: out.value.mesh as MeshAsset };
    });
    const everything: number[] = [];
    for (const p of posed) everything.push(...Array.from(meshPositions(p.mesh)));
    const aspect = WIDTH / HEIGHT;
    const view = fitView(everything, DIRECTION, aspect, CASE_FOV, 0.84);
    const baked = (t: TextureSink): StandardMaterialOptions =>
      ({
        baseColor: [1, 1, 1, 1],
        metallic: 1,
        roughness: 1,
        baseColorTexture: { texture: t('clip-albedo', texture(raw('albedo'), 'color', true, 1)) },
        normalTexture: { texture: t('clip-normal', texture(raw('normal'), 'normal', false, 1)) },
        metallicRoughnessTexture: { texture: t('clip-orm', texture(raw('orm'), 'ormh', false, 1)) },
        occlusionTexture: { texture: t('clip-orm', texture(raw('orm'), 'ormh', false, 1)) },
      }) as StandardMaterialOptions;
    const slots: Record<string, Rgb> = { Default: [0.5, 0.52, 0.55], baked: [0.5, 0.52, 0.55] };
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots, view, clearColor: CLEAR, far: 400, ambientIrradiance: TURRET_AMBIENT, materials: { baked } });
    const frames: Record<string, PNG> = {};
    try {
      r.aim(view);
      for (const p of posed) frames[p.name] = await r.render(p.mesh);
      for (const png of Object.values(frames)) expect(r.covered(png)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      expect(r.state()).toBe('alive');
    } finally {
      await r.dispose();
    }
    if (OUT === undefined) return;
    mkdirSync(OUT, { recursive: true });
    const small = posed.map((p) => shrink(frames[p.name] as PNG, 2));
    const strip = new PNG({ width: small.length * (WIDTH / 2), height: HEIGHT / 2 });
    small.forEach((s, i) => (PNG as unknown as { bitblt: (...a: unknown[]) => void }).bitblt(s, strip, 0, 0, s.width, s.height, i * s.width, 0));
    posed.forEach((p, i) => writeFileSync(join(OUT, `V-clip-${i}-${p.name}.png`), PNG.sync.write(frames[p.name] as PNG)));
    writeFileSync(join(OUT, 'V-clip-strip.png'), PNG.sync.write(strip));
  });
});
