// @forgeax/engine-graphics-extras - glyph layout algorithm
// (feat-20260531-world-space-msdf-text-rendering M4 / w15).
//
// Pure functions: lay out a `GlyphText` string against a `FontAsset`'s glyph
// metrics into per-glyph quad vertices (position + uv) and indices, plus a
// conservative bounding-sphere radius for pick (plan-strategy D-5). NO ECS,
// NO GPU -- the mesh baking (12-float stride fill + register) is the job of
// `glyph-mesh-bake.ts` (w17); this module produces only the geometry data.
//
// Layout model (plan-strategy D-2 / D-4 / D-5):
//   - left-aligned: the pen advances by `metric.advance * fontSize` per glyph.
//   - baseline at local y = 0 on the first line; the local space is Y-up so a
//     glyph quad's top edge sits at `penY - bearingY*s + size.h*s` and its
//     bottom edge at `penY - bearingY*s` (BMFont yoffset measures DOWN from
//     the line top; we negate into Y-up so higher bearingY -> lower top).
//   - `\n` resets penX to 0 and drops penY by `lineHeight * fontSize`
//     (line-2 baseline = -lineHeight, AC-21).
//   - missing codepoint -> notdef TOFU fallback; the glyph still counts and
//     emits a quad (AC-14). A codepoint with neither a metric nor a notdef
//     emits no quad but still advances by the notdef-or-zero advance.
//   - empty string -> zero vertices / zero indices / radius 0 (the bake
//     helper registers a 0-vertex mesh, which is legal; pick skips it).
//
// Vertex layout produced here is the 12-float canonical stride
// (PROCEDURAL_FLOATS_PER_VERTEX): position(vec3) + normal(vec3) + uv(vec2) +
// tangent(vec4). This module writes position + uv as real values and leaves
// normal/tangent as placeholder constants so the buffer is register-ready
// without a second pass (R-2: 12-float stride is a hard register gate). The
// per-vertex offsets are exported so the bake helper + tests share one SSOT.

import { PROCEDURAL_FLOATS_PER_VERTEX } from '@forgeax/engine-geometry';
import type { FontAsset, GlyphMetric } from '@forgeax/engine-types';
import { TextError } from '@forgeax/engine-types';

/**
 * Canonical 12-float vertex stride (position vec3 + normal vec3 + uv vec2 +
 * tangent vec4) owned by `PROCEDURAL_FLOATS_PER_VERTEX` in
 * `@forgeax/engine-geometry`. R-2: the baked mesh must satisfy this stride or `register`
 * fail-fasts with `mesh-vertex-stride-mismatch`.
 */
/** Byte-free float offsets within a single 12-float vertex. */
export const VERTEX_OFFSET = {
  position: 0, // vec3
  normal: 3, // vec3 (placeholder (0,0,1))
  uv: 6, // vec2
  tangent: 8, // vec4 (placeholder (0,0,0,1))
} as const;

/** Soft per-frame concurrent-font ceiling (plan-strategy D-8 / AC-20). */
export const FONT_CONCURRENCY_LIMIT = 8;

/** Layout output: per-glyph quad geometry + conservative sphere radius. */
export interface GlyphLayoutResult {
  /** 12-float-stride interleaved vertices (4 vertices per glyph). */
  readonly vertices: Float32Array;
  /** Triangle indices (6 per glyph: two triangles). */
  readonly indices: Uint16Array;
  /**
   * Conservative bounding-sphere radius from the anchor (local origin) to the
   * farthest glyph quad corner (plan-strategy D-5). The bake helper turns this
   * into a cube AABB (half-side = radius) so pick is orientation-independent.
   */
  readonly radius: number;
}

// Module-level set tracking distinct FontAsset handle ids active in the
// current frame. The layout system resets this at the top of each frame
// (resetFontConcurrency) and calls trackFontConcurrency once per distinct
// font; the 9th distinct font throws a structured TextError (D-8 rejects
// silently evicting the oldest font).
const activeFontIds = new Set<number>();

/** Reset the per-frame concurrent-font tracker (call once at frame start). */
export function resetFontConcurrency(): void {
  activeFontIds.clear();
}

/**
 * Track one distinct FontAsset handle id as active this frame. Re-tracking an
 * already-active id is a no-op; the (N+1)th distinct id beyond
 * {@link FONT_CONCURRENCY_LIMIT} throws `TextError('font-concurrency-exceeded')`
 * (plan-strategy D-8 / AC-20).
 */
export function trackFontConcurrency(fontId: number): void {
  if (activeFontIds.has(fontId)) return;
  if (activeFontIds.size >= FONT_CONCURRENCY_LIMIT) {
    throw new TextError({
      code: 'font-concurrency-exceeded',
      expected: String(FONT_CONCURRENCY_LIMIT),
      hint: 'reuse a shared FontAsset across labels, or split text into fewer distinct fonts per frame',
      detail: { active: activeFontIds.size, limit: FONT_CONCURRENCY_LIMIT, rejected: fontId },
    });
  }
  activeFontIds.add(fontId);
}

const NEWLINE = '\n'.codePointAt(0) as number;

/**
 * Lay out `text` against `font` at `fontSize`, producing per-glyph quad
 * geometry (12-float stride) + indices + the conservative sphere radius.
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
  const vertices = new Float32Array(glyphCount * 4 * PROCEDURAL_FLOATS_PER_VERTEX);
  const indices = new Uint16Array(glyphCount * 6);

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
    writeVertex(vertices, g * 4 + 0, q.x0, q.y1, u0, v0);
    writeVertex(vertices, g * 4 + 1, q.x1, q.y1, u1, v0);
    writeVertex(vertices, g * 4 + 2, q.x1, q.y0, u1, v1);
    writeVertex(vertices, g * 4 + 3, q.x0, q.y0, u0, v1);
    const vbase = g * 4;
    const ibase = g * 6;
    indices[ibase + 0] = vbase + 0;
    indices[ibase + 1] = vbase + 1;
    indices[ibase + 2] = vbase + 2;
    indices[ibase + 3] = vbase + 0;
    indices[ibase + 4] = vbase + 2;
    indices[ibase + 5] = vbase + 3;
  }

  return { vertices, indices, radius: maxCornerDist };
}

/** Write one 12-float vertex (position + placeholder normal + uv + placeholder tangent). */
function writeVertex(
  out: Float32Array,
  vertexIndex: number,
  x: number,
  y: number,
  u: number,
  v: number,
): void {
  const o = vertexIndex * PROCEDURAL_FLOATS_PER_VERTEX;
  // position (vec3)
  out[o + VERTEX_OFFSET.position + 0] = x;
  out[o + VERTEX_OFFSET.position + 1] = y;
  out[o + VERTEX_OFFSET.position + 2] = 0;
  // normal placeholder (0,0,1)
  out[o + VERTEX_OFFSET.normal + 0] = 0;
  out[o + VERTEX_OFFSET.normal + 1] = 0;
  out[o + VERTEX_OFFSET.normal + 2] = 1;
  // uv (vec2)
  out[o + VERTEX_OFFSET.uv + 0] = u;
  out[o + VERTEX_OFFSET.uv + 1] = v;
  // tangent placeholder (0,0,0,1)
  out[o + VERTEX_OFFSET.tangent + 0] = 0;
  out[o + VERTEX_OFFSET.tangent + 1] = 0;
  out[o + VERTEX_OFFSET.tangent + 2] = 0;
  out[o + VERTEX_OFFSET.tangent + 3] = 1;
}
