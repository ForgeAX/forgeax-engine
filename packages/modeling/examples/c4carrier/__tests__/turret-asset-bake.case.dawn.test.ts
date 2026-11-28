import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EditMesh, encodeSnapshot, mipChain, model, sel, type StandardMaterialOptions, type TextureSink } from '@forgeax/engine-modeling';
import type { MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CASE_FOV, checkerTexture, createCaseRenderer, layoutView, type Rgb } from '../../case/render';
import { LOW_NORMALS, SLOTS, UV_ATLAS } from '../asset';
import { fitView, meshPositions, TURRET_AMBIENT } from '../frame';

/**
 * C-600 turret asset, stage 2: the baked low mesh beside the high-poly source on one camera
 * (Dawn). Reads the maps written by case/bake.mts and case/compose.mts; skipped without them.
 * With FORGEAX_CASE_OUT set it writes the 1600x1200 comparison and map views.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const MAPS = process.env.FORGEAX_C4_MAPS ?? '/tmp/c4-turret-asset/out/maps';
const WORK = process.env.FORGEAX_C4_WORK ?? '/tmp/c4-turret-asset/work';
const READY = existsSync(join(MAPS, 'composed.ready')) || existsSync(join(MAPS, 'albedo.rgba'));
const WIDTH = OUT === undefined ? 320 : 1600;
const HEIGHT = OUT === undefined ? 240 : 1200;
const SIZE = UV_ATLAS.resolution;
const CLEAR: [number, number, number, number] = [0.1095, 0.1195, 0.1413, 1];
const DIRECTION = [0.56, 0.42, 0.71];
const GAP = 24;
const RIGHT = [0.785, 0, -0.62];
const SHIFT = [RIGHT[0] as number * GAP, 0, RIGHT[2] as number * GAP] as const;

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
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

function grey(source: Uint8Array, channel: number): Uint8Array {
  const out = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 4) out.set([source[i + channel] as number, source[i + channel] as number, source[i + channel] as number, 255], i);
  return out;
}

function mapQuad(slot: string): MeshAsset {
  const flat = new EditMesh();
  const loop = [flat.addVertex(0, 0, 0), flat.addVertex(1, 0, 0), flat.addVertex(1, 1, 0), flat.addVertex(0, 1, 0)];
  const f = flat.addFace(loop, flat.nameIndex(flat.materialNames, slot)).unwrap();
  for (const h of flat.faceHalves(f)) {
    const p = flat.position(flat.hVert[h] as number);
    flat.setCorner('uv0', h, [p[0], 1 - p[1]]);
  }
  const view = model();
  view.append(encodeSnapshot(flat));
  const out = view.toMesh({ normals: { mode: 'flat' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

describe.skipIf(!READY)('C-600 turret asset: baked low beside the high (Dawn)', () => {
  it('renders the comparison and the baked maps', { timeout: 3600000 }, async () => {
    const low = model({ budget: { work: 4e9 } });
    low.append(new Uint8Array(readFileSync(join(WORK, 'low-uv.fxem'))));
    const high = model({ budget: { work: 4e9 } });
    high.append(new Uint8Array(readFileSync(join(WORK, 'high.fxem'))));
    const compare = (slot: string, withHigh: boolean): MeshAsset => {
      const view = model({ budget: { work: 4e9 } });
      view.append(low.snapshot());
      view.assign(sel.all(), slot);
      if (withHigh) view.append(high.snapshot(), { translate: [...SHIFT] });
      const out = view.toMesh({ normals: LOW_NORMALS });
      if (!out.ok) throw out.error;
      return out.value.mesh;
    };
    const lowOnly = (slot: string): MeshAsset => compare(slot, false);

    const ormh = raw('ormh');
    const baked = (albedo: TextureAsset, normal: TextureAsset, ormTexture: TextureAsset, keys: string) => (t: TextureSink): StandardMaterialOptions =>
      ({
        baseColor: [1, 1, 1, 1],
        metallic: 1,
        roughness: 1,
        baseColorTexture: { texture: t(`${keys}-albedo`, albedo) },
        normalTexture: { texture: t(`${keys}-normal`, normal) },
        metallicRoughnessTexture: { texture: t(`${keys}-orm`, ormTexture) },
        occlusionTexture: { texture: t(`${keys}-orm`, ormTexture) },
      }) as StandardMaterialOptions;
    const mapMaterial = (key: string, map: TextureAsset) => (t: TextureSink): StandardMaterialOptions =>
      ({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1, baseColorTexture: { texture: t(key, map) } }) as StandardMaterialOptions;
    const slotColors: Record<string, Rgb> = {};
    const slotMaterials: Record<string, (t: TextureSink) => StandardMaterialOptions> = {};
    for (const [slot, s] of Object.entries(SLOTS)) {
      const options = {
        baseColor: [linear(s.baseColor[0]), linear(s.baseColor[1]), linear(s.baseColor[2]), 1],
        metallic: s.metallic,
        roughness: s.roughness,
      } as StandardMaterialOptions;
      slotMaterials[slot] = () => options;
      slotColors[slot] = [linear(s.baseColor[0]), linear(s.baseColor[1]), linear(s.baseColor[2])] as unknown as Rgb;
    }
    slotColors.Default = [0.5, 0.52, 0.55];
    const make = (view: ReturnType<typeof fitView>, materials: Record<string, (t: TextureSink) => StandardMaterialOptions>) =>
      createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: slotColors, view, clearColor: CLEAR, far: 400, ambientIrradiance: TURRET_AMBIENT, checker: checkerTexture(2048, 256), materials: { ...slotMaterials, ...materials } });

    const pair = compare('baked', true);
    const lowBaked = lowOnly('baked');
    const aspect = WIDTH / HEIGHT;
    const view = (direction: readonly number[]) => fitView(meshPositions(pair), direction, aspect, CASE_FOV, 0.84);
    const views: Record<string, PNG> = {};
    const all = meshPositions(pair);
    const near: number[] = [];
    // The close view frames the whole house and barrels (local z above 6 m) of both turrets, so neither copy is cropped on the right.
    for (let i = 0; i < all.length; i += 3) {
      for (const [dx, dz] of [[0, 0], [SHIFT[0], SHIFT[2]]] as const) {
        const lx = (all[i] as number) - dx;
        const lz = (all[i + 2] as number) - dz;
        if (lz > 6 && lz < 24 && Math.abs(lx) < 9.5) near.push(all[i] as number, all[i + 1] as number, all[i + 2] as number);
      }
    }
    const first = await make(view(DIRECTION), { baked: baked(texture(raw('baseColor'), 'color', true, 1), texture(raw('normal'), 'normal', false, 1), texture(ormh, 'ormh', false, 1), 'bake') });
    try {
      first.aim(view(DIRECTION));
      views['V-baked-vs-high'] = await first.render(pair);
      first.aim(view([-0.56, 0.42, -0.71]));
      views['V-baked-vs-high-rear'] = await first.render(pair);
      first.aim(fitView(near, DIRECTION, aspect, CASE_FOV, 0.84));
      views['V-baked-vs-high-close'] = await first.render(pair);
      first.aim(fitView(meshPositions(lowBaked), DIRECTION, aspect, CASE_FOV, 0.84));
      views['V-baked-low'] = await first.render(lowBaked);
      expect(first.covered(views['V-baked-vs-high'] as PNG)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      expect(first.state()).toBe('alive');
    } finally {
      await first.dispose();
    }
    const second = await make(view(DIRECTION), { baked: baked(texture(raw('albedo'), 'color', true, 1), texture(raw('normal'), 'normal', false, 1), texture(raw('orm'), 'ormh', false, 1), 'wear') });
    try {
      second.aim(fitView(meshPositions(lowBaked), DIRECTION, aspect, CASE_FOV, 0.84));
      views['V-baked-wear'] = await second.render(lowBaked);
      second.aim(fitView(meshPositions(pair), DIRECTION, aspect, CASE_FOV, 0.84));
      views['V-baked-wear-vs-high'] = await second.render(pair);
    } finally {
      await second.dispose();
    }
    const third = await make(layoutView(aspect), {
      'map-normal': mapMaterial('c4-normal', texture(raw('normal'), 'normal', false, 2)),
      'map-ao': mapMaterial('c4-ao', texture(grey(ormh, 0), 'color', false, 2)),
      'map-id': mapMaterial('c4-id', texture(raw('materialId'), 'color', true, 2)),
    });
    try {
      third.aim(layoutView(aspect));
      for (const [name, slot] of [['V-map-normal', 'map-normal'], ['V-map-ao', 'map-ao'], ['V-map-id', 'map-id']] as const) views[name] = await third.render(mapQuad(slot));
      expect(third.state()).toBe('alive');
    } finally {
      await third.dispose();
    }
    if (OUT === undefined) return;
    mkdirSync(OUT, { recursive: true });
    for (const [name, png] of Object.entries(views)) writeFileSync(join(OUT, `${name}.png`), PNG.sync.write(png));
  });
});
