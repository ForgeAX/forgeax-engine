import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { buildGlyphMeshAsset, layoutGlyphText } from '@forgeax/engine-graphics-extras';
import type { FontAsset, GlyphMetric } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

// ─── from glyph-layout.test.ts ───
describe('glyph-layout.test.ts', () => {
  // Minimal metric: 10-unit advance, square 8x8 glyph, bearingY=8 (sits on baseline).
  function metric(overrides: Partial<GlyphMetric> = {}): GlyphMetric {
    return {
      advance: 10,
      bearingX: 0,
      bearingY: 8,
      size: { w: 8, h: 8 },
      region: { x: 0, y: 0, w: 8, h: 8 },
      ...overrides,
    };
  }

  function makeFont(glyphs: Record<number, GlyphMetric>, notdef?: GlyphMetric): FontAsset {
    return {
      kind: 'font',
      atlas: 0 as never,
      sampler: 0 as never,
      glyphs,
      common: {
        lineHeight: 12,
        base: 8,
        distanceRange: 4,
        pxRange: 4,
        atlasWidth: 64,
        atlasHeight: 64,
      },
      ...(notdef !== undefined ? { notdef } : {}),
    };
  }

  const STRIDE = 3;

  describe('layoutGlyphText', () => {
    it('(a) N glyphs -> 4N vertices / 6N indices', () => {
      const H = 'H'.codePointAt(0) as number;
      const i = 'i'.codePointAt(0) as number;
      const font = makeFont({ [H]: metric(), [i]: metric() });
      const out = layoutGlyphText(font, 'Hi', 1);
      expect(out.attributes.position.length).toBe(2 * 4 * STRIDE); // 8 verts
      expect(out.indices.length).toBe(2 * 6); // 12 indices
    });

    it('(b) absent codepoints fall back to notdef and still count (TOFU, AC-14)', () => {
      // Empty glyph map but a notdef present -> 'AB' renders 2 TOFU quads.
      const font = makeFont({}, metric({ region: { x: 56, y: 56, w: 8, h: 8 } }));
      const out = layoutGlyphText(font, 'AB', 1);
      expect(out.attributes.position.length).toBe(2 * 4 * STRIDE);
      expect(out.indices.length).toBe(2 * 6);
      // both quads use the notdef atlas region -> uv of first vertex is notdef's
      // top-left region normalized by atlas size.
      const u0 = out.attributes.uv[0] as number; // vertex 0 uv.u
      expect(u0).toBeCloseTo(56 / 64, 5);
    });

    it('(c) \\n second line baseline y offset = -lineHeight (AC-21)', () => {
      const A = 'A'.codePointAt(0) as number;
      const B = 'B'.codePointAt(0) as number;
      const font = makeFont({ [A]: metric(), [B]: metric() });
      const out = layoutGlyphText(font, 'A\nB', 1);
      // 2 glyphs (newline emits no quad).
      expect(out.attributes.position.length).toBe(2 * 4 * STRIDE);
      // Glyph A vertex 0 y vs glyph B vertex 0 y differ by exactly lineHeight.
      const aY0 = out.attributes.position[1] as number; // glyph0 vert0 position.y
      const bY0 = out.attributes.position[4 * STRIDE + 1] as number; // glyph1 vert0 position.y
      expect(bY0).toBeCloseTo(aY0 - font.common.lineHeight, 5);
    });

    it('(d) empty string -> 0 vertices / 0 indices', () => {
      const font = makeFont({});
      const out = layoutGlyphText(font, '', 1);
      expect(out.attributes.position.length).toBe(0);
      expect(out.indices.length).toBe(0);
      expect(out.radius).toBe(0);
    });

    it('(e) conservative sphere R covers the farthest glyph quad corner (D-5)', () => {
      const H = 'H'.codePointAt(0) as number;
      const font = makeFont({ [H]: metric() });
      const out = layoutGlyphText(font, 'HHHH', 1);
      // farthest corner distance from origin (anchor) must be <= R.
      let maxCornerDist = 0;
      for (let v = 0; v < out.attributes.position.length; v += STRIDE) {
        const x = out.attributes.position[v] as number;
        const y = out.attributes.position[v + 1] as number;
        maxCornerDist = Math.max(maxCornerDist, Math.hypot(x, y));
      }
      expect(out.radius).toBeGreaterThanOrEqual(maxCornerDist - 1e-6);
      expect(out.radius).toBeGreaterThan(0);
    });

    it('packs the same complete attributes used by glyph picking', () => {
      const layout = layoutGlyphText(makeFont({ 65: metric() }), 'A', 2);
      const mesh = buildGlyphMeshAsset(layout);
      const decoded = unpackInterleavedVertexAttributes(
        mesh.vertices,
        deriveVertexLayoutProjection(DEFAULT_VERTEX_ATTRIBUTE_MAP),
      );
      expect(decoded).toEqual(layout.attributes);
      expect(mesh.submeshes[0]?.vertexCount).toBe(4);
      expect([...layout.attributes.normal]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
      expect([...layout.attributes.tangent]).toEqual([
        0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1,
      ]);
    });

    it('preserves indices above 16,384 glyphs', () => {
      const font = makeFont({ 65: metric() });
      const out = layoutGlyphText(font, 'A'.repeat(16385), 1);
      expect(out.indices).toBeInstanceOf(Uint32Array);
      expect(out.indices.at(-1)).toBe(65539);
    });
  });
});
