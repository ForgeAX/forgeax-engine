import { AssetGuid } from '@forgeax/engine/pack/guid';
import { GlyphText } from '@forgeax/engine/render/authoring';
import { Transform } from '@forgeax/engine/scene';
import type { FontAsset, SamplerAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { buildSdfFont } from './_shared/sdf-font';
import { spawnOrthoCamera } from './_shared/sprite';

const ATLAS_GUID = '019f2d10-0000-7000-8000-00000000a701';
const SAMPLER_GUID = '019f2d10-0000-7000-8000-00000000a702';
const ON_TEXT = 'FORGEAX\n2D TEXT';
const OFF_TEXT = 'SPRITE';

export default defineFeature({
  title: 'World-space MSDF Text',
  catalog: 'World-space MSDF Text',
  kind: 'visual',
  summary:
    'A GlyphText entity references an in-memory FontAsset (distance-field atlas + glyph metrics, catalogued by GUID); the layout system bakes a MeshAsset and a forgeax::msdf-text material, and re-bakes when text or color changes.',
  expect:
    'ON: two lines "FORGEAX" / "2D TEXT" in orange and a smaller cyan "SPRITE" row with crisp edges. OFF: the big text changes to a single line "SPRITE" in green, so the glyphs and color both re-layout.',
  setup({ app, world, canvas }) {
    const assets = app.assets;
    if (assets === undefined) throw new Error('app.assets is undefined');
    const atlasGuid = AssetGuid.parse(ATLAS_GUID);
    const samplerGuid = AssetGuid.parse(SAMPLER_GUID);
    if (!atlasGuid.ok || !samplerGuid.ok) throw new Error('guid parse failed');
    const { atlas, font } = buildSdfFont(atlasGuid.value, samplerGuid.value);
    const sampler: SamplerAsset = {
      kind: 'sampler',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
    };
    const cataloged = [
      assets.catalog(atlasGuid.value, atlas),
      assets.catalog(samplerGuid.value, sampler),
    ];
    for (const result of cataloged)
      if (!result.ok) throw new Error(`catalog: ${result.error.code}`);
    const fontHandle = world.allocSharedRef<'FontAsset', FontAsset>('FontAsset', font);
    spawnOrthoCamera(world, canvas);
    const big = world
      .spawn(
        { component: Transform, data: { pos: [-3.6, 0.8, 0] } },
        {
          component: GlyphText,
          data: { fontHandle, text: ON_TEXT, fontSize: 0.018, color: [1, 0.55, 0.1, 1] },
        },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [-3.6, -1.7, 0] } },
        {
          component: GlyphText,
          data: { fontHandle, text: 'SPRITE', fontSize: 0.008, color: [0.2, 0.9, 1, 1] },
        },
      )
      .unwrap();
    return {
      toggle(on) {
        world.set(big, GlyphText, {
          text: on ? ON_TEXT : OFF_TEXT,
          color: on ? [1, 0.55, 0.1, 1] : [0.2, 1, 0.3, 1],
        } as never);
      },
    };
  },
});
