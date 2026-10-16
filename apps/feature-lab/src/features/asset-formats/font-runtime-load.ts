import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import type { FontAsset } from '@forgeax/engine/types';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { checker, errorCode, guid, installMemoryPack } from './fixtures/memory-pack';

const FONT = guid(0x741);
const BROKEN = guid(0x742);
const ATLAS = guid(0x743);
const SAMPLER = guid(0x744);
const COMMON = {
  lineHeight: 16,
  base: 12,
  distanceRange: 4,
  pxRange: 4,
  atlasWidth: 16,
  atlasHeight: 16,
};
const GLYPHS = {
  '65': {
    advance: 9,
    bearingX: 0,
    bearingY: 8,
    size: { w: 8, h: 8 },
    region: { x: 0, y: 0, w: 8, h: 8 },
  },
  '66': {
    advance: 9,
    bearingX: 0,
    bearingY: 8,
    size: { w: 8, h: 8 },
    region: { x: 8, y: 0, w: 8, h: 8 },
  },
};

async function load(assets: AssetRegistry, id: string) {
  const parsed = AssetGuid.parse(id);
  if (!parsed.ok) return { ok: false as const, error: parsed.error };
  return assets.loadByGuid<FontAsset>(parsed.value);
}

export default defineFeature({
  title: 'Font runtime load',
  catalog: 'Font runtime load',
  kind: 'probe',
  summary:
    'A Pack v2 font row (glyph metrics + common block, referencing an atlas texture and sampler by GUID) is decoded by the runtime font decoder into a FontAsset that GlyphText layout consumes; malformed payloads fail at load instead of at layout.',
  expect:
    'The font row loads through app.assets with both glyphs and the common block intact, its atlas and sampler GUIDs resolve, and a row missing the common block fails with a structured code.',
  async setup({ app, world }) {
    spawnStage(world);
    const checks: FeatureCheck[] = [];
    const assets = app.assets;
    if (assets === undefined) return { checks: () => [{ name: 'app.assets present', ok: false }] };
    installMemoryPack(
      assets,
      [
        {
          guid: ATLAS,
          kind: 'texture',
          payload: {
            kind: 'texture',
            colorSpace: 'linear',
            shape: { viewDimension: '2d', extent: { width: 16, height: 16 } },
            format: 'rgba8unorm',
            mips: { kind: 'none' },
          },
          artifacts: {
            body: {
              path: 'font/atlas.bin',
              mediaType: 'application/octet-stream',
              bytes: checker(),
              assetCodec: { name: 'rgba8' },
            },
          },
        },
        {
          guid: SAMPLER,
          kind: 'sampler',
          payload: {
            kind: 'sampler',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'nearest',
          },
        },
        {
          guid: FONT,
          kind: 'font',
          payload: {
            kind: 'font',
            atlasGuid: ATLAS,
            samplerGuid: SAMPLER,
            glyphs: GLYPHS,
            common: COMMON,
          },
          refs: [ATLAS, SAMPLER],
        },
        {
          guid: BROKEN,
          kind: 'font',
          payload: { kind: 'font', atlasGuid: ATLAS, samplerGuid: SAMPLER, glyphs: GLYPHS },
          refs: [ATLAS, SAMPLER],
        },
      ],
      'https://feature-lab.invalid/asset-formats/font.pack.json',
    );
    const font = await load(assets, FONT);
    checks.push({
      name: 'font row loads',
      ok: font.ok,
      ...(font.ok ? {} : { detail: errorCode(font.error) }),
    });
    if (font.ok) {
      checks.push({
        name: 'two glyphs decoded',
        ok: Object.keys(font.value.glyphs).length === 2,
        detail: Object.keys(font.value.glyphs).join(','),
      });
      checks.push({
        name: 'common block intact',
        ok: JSON.stringify(font.value.common) === JSON.stringify(COMMON),
      });
      checks.push({
        name: 'atlas and sampler GUIDs preserved',
        ok:
          AssetGuid.format(font.value.atlas) === ATLAS &&
          AssetGuid.format(font.value.sampler) === SAMPLER,
      });
    }
    const atlas = await load(assets, ATLAS);
    checks.push({
      name: 'referenced atlas loads',
      ok: atlas.ok,
      ...(atlas.ok ? {} : { detail: errorCode(atlas.error) }),
    });
    const broken = await load(assets, BROKEN);
    checks.push({
      name: 'missing common block fails',
      ok: !broken.ok,
      detail: broken.ok ? 'loaded' : errorCode(broken.error),
    });
    return { checks: () => checks };
  },
});
