// Pure Font metric layout. Emits canonical position/UV quads with normal/tangent
// defaults; newlines move by lineHeight, missing glyphs use notdef when available.
// Renderer and Picking consume the same kernel without creating asset identities.

import type { FontAsset, GlyphMetric } from '@forgeax/engine-types';

/** Layout output: per-glyph quad geometry + conservative sphere radius. */
export interface GlyphLayoutResult {
  /** Four vertices per glyph, in Geometry's canonical attribute vocabulary. */
  readonly attributes: Readonly<Record<'position' | 'normal' | 'uv' | 'tangent', Float32Array>>;
  /** Triangle indices (6 per glyph: two triangles). */
  readonly indices: Uint16Array | Uint32Array;
  /**
   * Conservative bounding-sphere radius from the anchor (local origin) to the
   * farthest glyph quad corner (plan-strategy D-5). The bake helper turns this
   * into a cube AABB (half-side = radius) so pick is orientation-independent.
   */
  readonly radius: number;
}

const NEWLINE = '\n'.codePointAt(0) as number;

/**
 * Lay out `text` against `font` at `fontSize`, producing per-glyph quad
 * canonical attribute geometry + indices + the conservative sphere radius.
 *
 * @param font The resolved FontAsset (glyph metrics + common block).
 * @param text The authoring string (`\n` starts a new line).
 * @param fontSize Uniform scale applied to all metric units.
 */
export function layoutGlyphText(
  font: FontAsset,
  text: string,
  fontSize: number,
): GlyphLayoutResult {
  const s = fontSize;
  const { atlasWidth, atlasHeight, lineHeight } = font.common;

  // First pass over code points: collect the renderable glyph quads.
  const quads: Array<{ x0: number; y0: number; x1: number; y1: number; m: GlyphMetric }> = [];
  let penX = 0;
  let penY = 0;
  let maxCornerDist = 0;

  // Iterate by code point so surrogate pairs count as one glyph.
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === NEWLINE) {
      penX = 0;
      penY -= lineHeight * s;
      continue;
    }
    const metric = font.glyphs[cp] ?? font.notdef;
    if (metric === undefined) {
      // Neither a glyph nor a notdef -> nothing to render; advance by zero so
      // the cursor does not jump (rare: a font with no notdef and missing cp).
      continue;
    }
    // Quad corners in Y-up local space (baseline at penY).
    const x0 = penX + metric.bearingX * s;
    const yTop = penY - metric.bearingY * s + metric.size.h * s;
    const yBot = penY - metric.bearingY * s;
    const x1 = x0 + metric.size.w * s;
    quads.push({ x0, y0: yBot, x1, y1: yTop, m: metric });
    maxCornerDist = Math.max(
      maxCornerDist,
      Math.hypot(x0, yBot),
      Math.hypot(x1, yBot),
      Math.hypot(x0, yTop),
      Math.hypot(x1, yTop),
    );
    penX += metric.advance * s;
  }

  const glyphCount = quads.length;
  const attributes = {
    position: new Float32Array(glyphCount * 4 * 3),
    normal: new Float32Array(glyphCount * 4 * 3),
    uv: new Float32Array(glyphCount * 4 * 2),
    tangent: new Float32Array(glyphCount * 4 * 4),
  };
  const indices =
    glyphCount * 4 > 65536 ? new Uint32Array(glyphCount * 6) : new Uint16Array(glyphCount * 6);

  for (let g = 0; g < glyphCount; g++) {
    const q = quads[g] as (typeof quads)[number];
    const { region } = q.m;
    // Atlas UV (top-left origin) normalized into [0,1].
    const u0 = region.x / atlasWidth;
    const u1 = (region.x + region.w) / atlasWidth;
    const v0 = region.y / atlasHeight;
    const v1 = (region.y + region.h) / atlasHeight;
    // 4 corners: TL, TR, BR, BL (CCW); position z = 0 (billboard before).
    // uv pairs the top edge (y1) with v0 and the bottom edge (y0) with v1.
    writeVertex(attributes, g * 4 + 0, q.x0, q.y1, u0, v0);
    writeVertex(attributes, g * 4 + 1, q.x1, q.y1, u1, v0);
    writeVertex(attributes, g * 4 + 2, q.x1, q.y0, u1, v1);
    writeVertex(attributes, g * 4 + 3, q.x0, q.y0, u0, v1);
    const vbase = g * 4;
    const ibase = g * 6;
    indices[ibase + 0] = vbase + 0;
    indices[ibase + 1] = vbase + 1;
    indices[ibase + 2] = vbase + 2;
    indices[ibase + 3] = vbase + 0;
    indices[ibase + 4] = vbase + 2;
    indices[ibase + 5] = vbase + 3;
  }

  return { attributes, indices, radius: maxCornerDist };
}

/** Glyph geometry supplies semantic attributes; Geometry owns packing offsets. */
function writeVertex(
  out: GlyphLayoutResult['attributes'],
  vertexIndex: number,
  x: number,
  y: number,
  u: number,
  v: number,
): void {
  out.position[vertexIndex * 3] = x;
  out.position[vertexIndex * 3 + 1] = y;
  out.normal[vertexIndex * 3 + 2] = 1;
  out.uv[vertexIndex * 2] = u;
  out.uv[vertexIndex * 2 + 1] = v;
  out.tangent[vertexIndex * 4 + 3] = 1;
}
