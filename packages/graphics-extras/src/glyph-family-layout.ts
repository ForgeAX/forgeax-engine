import { err, type FontAsset, type GlyphMetric, type MeshAsset, ok } from '@forgeax/engine-types';
import type { GlyphLayoutResult } from './glyph-layout';
import { buildGlyphMeshAsset } from './glyph-mesh-bake';

export interface GlyphFontRun {
  readonly fontIndex: number;
  readonly indexOffset: number;
  readonly indexCount: number;
  readonly vertexCount: number;
}
export interface GlyphFamilyLayout extends GlyphLayoutResult {
  readonly runs: readonly GlyphFontRun[];
  readonly advance: number;
  readonly ascent: number;
  readonly descent: number;
}
export interface GlyphFamilyLayoutOptions {
  readonly scale: number;
  /** Common baseline in local units; each face keeps its actual own ascent/bearings. */
  readonly baseline?: number;
  readonly alignment?: 'left' | 'center';
  readonly letterSpacing?: number;
  /** Real shaped pair advances in each font's baked metric units, indexed by
   * Unicode pair "left,right". No kerning is fabricated across fallback faces. */
  readonly kerning?: readonly Readonly<Record<string, number>>[];
}
/** Ordered native multi-atlas font fallback. No merged/rescaled font is made;
 * each glyph keeps its source face's metrics and UV, and every run selects the
 * corresponding native material slot. Primary-font line height owns newlines. */
export function layoutGlyphFamilyText(
  fonts: readonly FontAsset[],
  text: string,
  o: GlyphFamilyLayoutOptions,
) {
  const primaryFont = fonts[0];
  if (
    !primaryFont ||
    !Number.isFinite(o.scale) ||
    o.scale <= 0 ||
    !Number.isFinite(o.baseline ?? 0) ||
    !Number.isFinite(o.letterSpacing ?? 0)
  )
    return err({
      code: 'glyph-family-options-invalid' as const,
      expected: 'nonempty native FontAsset family and finite positive metric scale',
      hint: 'Resolve the source faces and pass actual layout metrics',
    });
  const placed = placeFamilyGlyphs(fonts, primaryFont, text, o);
  if (!placed.ok) return placed;
  return ok(buildFamilyLayout(fonts, placed.value, o));
}

interface GlyphQuad {
  fontIndex: number;
  metric: GlyphMetric;
  x: number;
  y: number;
}
interface GlyphLine {
  start: number;
  end: number;
  advance: number;
}
interface PlacedFamily {
  quads: GlyphQuad[];
  lines: GlyphLine[];
  ascent: number;
  descent: number;
}
function placeFamilyGlyphs(
  fonts: readonly FontAsset[],
  primaryFont: FontAsset,
  text: string,
  o: GlyphFamilyLayoutOptions,
) {
  const quads: GlyphQuad[] = [];
  const lines: GlyphLine[] = [];
  let pen = 0,
    line = 0,
    lineStart = 0,
    previous = -1,
    previousFont = -1,
    ascent = 0,
    descent = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (ch === '\n') {
      lines.push({
        start: lineStart,
        end: quads.length,
        advance: Math.max(0, pen - (o.letterSpacing ?? 0)),
      });
      lineStart = quads.length;
      line++;
      pen = 0;
      previous = -1;
      previousFont = -1;
      continue;
    }
    const fontIndex = fonts.findIndex((font) => font.glyphs[cp] !== undefined);
    if (fontIndex < 0)
      return err({
        code: 'glyph-family-glyph-missing' as const,
        expected: 'a real glyph in the declared source fallback chain',
        hint: 'Import the missing glyph from the source face rather than substituting a system font',
        detail: { codepoint: cp, text },
      });
    if (previousFont === fontIndex)
      pen += (o.kerning?.[fontIndex]?.[`${previous},${cp}`] ?? 0) * o.scale;
    const font = fonts[fontIndex];
    const metric = font?.glyphs[cp];
    if (!font || !metric) throw new Error('Selected font is missing its resolved glyph');
    ascent = Math.max(ascent, font.common.base);
    descent = Math.max(descent, font.common.lineHeight - font.common.base);
    quads.push({
      fontIndex,
      metric,
      x: pen + metric.bearingX * o.scale,
      y:
        (o.baseline ?? 0) -
        line * primaryFont.common.lineHeight * o.scale +
        (font.common.base - metric.bearingY) * o.scale,
    });
    pen += metric.advance * o.scale + (o.letterSpacing ?? 0);
    previous = cp;
    previousFont = fontIndex;
  }
  lines.push({
    start: lineStart,
    end: quads.length,
    advance: Math.max(0, pen - (text.endsWith('\n') ? 0 : (o.letterSpacing ?? 0))),
  });
  return ok({ quads, lines, ascent, descent });
}
function buildFamilyLayout(
  fonts: readonly FontAsset[],
  placed: PlacedFamily,
  o: GlyphFamilyLayoutOptions,
): GlyphFamilyLayout {
  const { quads, lines, ascent, descent } = placed;
  const attributes = {
    position: new Float32Array(quads.length * 12),
    normal: new Float32Array(quads.length * 12),
    uv: new Float32Array(quads.length * 8),
    tangent: new Float32Array(quads.length * 16),
  };
  const indices =
    quads.length * 4 > 65536
      ? new Uint32Array(quads.length * 6)
      : new Uint16Array(quads.length * 6);
  let radius = 0;
  const runs: {
    fontIndex: number;
    indexOffset: number;
    indexCount: number;
    vertexCount: number;
  }[] = [];
  for (const row of lines)
    for (let g = row.start; g < row.end; g++) {
      const q = quads[g];
      if (!q) throw new Error('Glyph line references a missing quad');
      const font = fonts[q.fontIndex];
      if (!font) throw new Error('Glyph quad references a missing font');
      const m = q.metric;
      const x = q.x - (o.alignment === 'center' ? row.advance / 2 : 0),
        top = q.y,
        bottom = top - m.size.h * o.scale,
        w = m.size.w * o.scale;
      const u0 = m.region.x / font.common.atlasWidth,
        u1 = (m.region.x + m.region.w) / font.common.atlasWidth,
        v0 = m.region.y / font.common.atlasHeight,
        v1 = (m.region.y + m.region.h) / font.common.atlasHeight;
      for (const [corner, px, py, u, v] of [
        [0, x, top, u0, v0],
        [1, x + w, top, u1, v0],
        [2, x + w, bottom, u1, v1],
        [3, x, bottom, u0, v1],
      ] as const) {
        const vertex = g * 4 + corner;
        attributes.position.set([px, py, 0], vertex * 3);
        attributes.normal[vertex * 3 + 2] = 1;
        attributes.uv.set([u, v], vertex * 2);
        attributes.tangent[vertex * 4 + 3] = 1;
        radius = Math.max(radius, Math.hypot(px, py));
      }
      indices.set([g * 4, g * 4 + 1, g * 4 + 2, g * 4, g * 4 + 2, g * 4 + 3], g * 6);
      const last = runs.at(-1);
      if (last?.fontIndex === q.fontIndex) {
        last.indexCount += 6;
        last.vertexCount += 4;
      } else
        runs.push({ fontIndex: q.fontIndex, indexOffset: g * 6, indexCount: 6, vertexCount: 4 });
    }
  return {
    attributes,
    indices,
    radius,
    runs,
    advance: Math.max(0, ...lines.map((l) => l.advance)),
    ascent,
    descent,
  };
}

export function buildGlyphFamilyMeshAsset(layout: GlyphFamilyLayout, fontCount: number): MeshAsset {
  const mesh = buildGlyphMeshAsset(layout);
  return {
    ...mesh,
    submeshes: layout.runs.map((run) => ({
      indexOffset: run.indexOffset,
      indexCount: run.indexCount,
      vertexCount: run.vertexCount,
      topology: 'triangle-list' as const,
      materialSlot: run.fontIndex,
    })),
    materialSlots: Array.from({ length: fontCount }, (_, index) => ({ slotName: `Font ${index}` })),
  };
}
