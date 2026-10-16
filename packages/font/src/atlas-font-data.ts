import type { FontAsset, GlyphMetric } from '@forgeax/engine-types';
import type { BakeAtlas } from './cli-font.js';

/** One atlas-to-font projection shared by CLI sidecars and imported payloads. */
export function atlasFontData(atlas: BakeAtlas): Pick<FontAsset, 'glyphs' | 'common'> {
  const glyphs: Record<number, GlyphMetric> = {};
  for (const g of atlas.glyphs) {
    glyphs[g.unicode] = {
      advance: g.advance,
      bearingX: g.xoffset,
      bearingY: g.yoffset,
      size: { w: g.atlasSize[0], h: g.atlasSize[1] },
      region: {
        x: g.atlasPosition[0],
        y: g.atlasPosition[1],
        w: g.atlasSize[0],
        h: g.atlasSize[1],
      },
    };
  }
  return {
    common: {
      lineHeight: atlas.metrics.lineHeight,
      base: atlas.metrics.ascender,
      distanceRange: atlas.fieldRange,
      pxRange: atlas.fieldRange,
      atlasWidth: atlas.textureSize[0],
      atlasHeight: atlas.textureSize[1],
    },
    glyphs,
  };
}
