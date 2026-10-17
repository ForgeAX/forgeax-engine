import type { FontAsset, GlyphMetric } from '@forgeax/engine-types';
import type { GlyphInfo, MSDFAtlas } from '@zappar/msdf-generator';

/**
 * Minimal subset of the @zappar/msdf-generator glyph record consumed by the
 * bake. Mirrors the package's `GlyphInfo` (dist/index.d.ts) -- only the fields
 * the BMFont -> FontAsset mapping needs (toolchain wiki section 4).
 */
export interface BakeGlyph
  extends Readonly<Pick<GlyphInfo, 'unicode' | 'advance' | 'xoffset' | 'yoffset'>> {
  readonly atlasPosition: Readonly<GlyphInfo['atlasPosition']>;
  readonly atlasSize: Readonly<GlyphInfo['atlasSize']>;
}

/**
 * Minimal subset of the @zappar/msdf-generator `MSDFAtlas` consumed by the
 * bake. `texture` carries the RGBA pixel buffer + dimensions (the package's
 * `ImageData`-shaped texture, but reduced to POD so the bake stays
 * environment-agnostic for testing).
 */
export interface BakeAtlas {
  readonly texture: { readonly width: number; readonly height: number; readonly data: Uint8Array };
  readonly glyphs: readonly BakeGlyph[];
  readonly metrics: Readonly<Pick<MSDFAtlas['metrics'], 'lineHeight' | 'ascender'>>;
  readonly textureSize: Readonly<MSDFAtlas['textureSize']>;
  readonly fieldRange: MSDFAtlas['fieldRange'];
}

/**
 * The bake-time MSDF generator contract. Injected into the bake and import entrypoints so
 * unit tests can supply a mock (real path: `@zappar/msdf-generator`'s `MSDF`).
 */
export interface MsdfGenerator {
  generateAtlas(ttf: Uint8Array): Promise<BakeAtlas>;
  dispose(): Promise<void>;
}

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
