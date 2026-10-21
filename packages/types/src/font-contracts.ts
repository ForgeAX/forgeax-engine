// Font and render-pipeline asset contracts.

import type { AssetHandle } from './asset-handle.js';
import type { AssetGuid } from './image-pack-contracts.js';

// === FontAsset POD shape (feat-20260531-world-space-msdf-text-rendering M2 / w5) ===
//
// Decision anchors:
//   - plan-strategy D-6 (FontAsset data shape: atlas Handle<TextureAsset> +
//     sampler Handle<SamplerAsset> + glyphs Record<codepoint, GlyphMetric> +
//     common block + optional notdef fallback; POD, math-free, fields 1:1
//     mirror toolchain wiki §4 BMFont char mapping)
//   - requirements AC-04 (FontAsset enters Asset closed union, 11->12)
//   - AGENTS.md §Component naming (single-semantic components drop the
//     Component suffix; FontAsset is a data asset, not an ECS component)
//
// GlyphMetric fields mirror the BMFont char block layout (toolchain wiki §4):
//   advance  <- xadvance  (horizontal distance to next glyph)
//   bearingX <- xoffset  (horizontal offset from cursor)
//   bearingY <- yoffset  (vertical offset from baseline)
//   size.{w,h} <- width/height (glyph quad size in layout space, before atlas
//     scale)
//   region.{x,y,w,h} <- atlas UV region in pixels (x/y = top-left corner
//     relative to atlas origin)

/**
 * Per-glyph metric layout — 1:1 mirror of BMFont char block fields
 * (toolchain wiki §4). POD, math-free.
 */
export interface GlyphMetric {
  /** Horizontal distance to the next glyph (xadvance). */
  readonly advance: number;
  /** Horizontal offset from cursor (xoffset). */
  readonly bearingX: number;
  /** Vertical offset from baseline (yoffset). */
  readonly bearingY: number;
  /** Glyph quad size in layout space. */
  readonly size: { readonly w: number; readonly h: number };
  /** Atlas UV region in pixels (top-left origin). */
  readonly region: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

/** Font metrics plus atlas/sampler dependencies. Runtime admission links source
 * GUIDs to managed references; rendering and queries consume fixed current content. */
export interface FontAsset {
  readonly kind: 'font';
  /** Source GUID; the runtime asset owner links and retains one Texture reference. */
  readonly atlas: AssetGuid | AssetHandle<'texture'>;
  /** Source GUID; the runtime asset owner links and retains one Sampler reference. */
  readonly sampler: AssetGuid | AssetHandle<'sampler'>;
  readonly glyphs: Record<number, GlyphMetric>;
  readonly common: {
    readonly lineHeight: number;
    readonly base: number;
    readonly distanceRange: number;
    readonly pxRange: number;
    readonly atlasWidth: number;
    readonly atlasHeight: number;
  };
  readonly notdef?: GlyphMetric;
}
