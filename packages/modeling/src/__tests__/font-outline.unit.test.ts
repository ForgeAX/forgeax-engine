import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Result } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { ModelingError } from '../errors';
import { type FontRegionResult, fontRegion, parseTrueTypeFont, type TrueTypeFont } from '../font';
import type { Point2 } from '../primitives';
import { region2d } from '../region2d';

const FIXTURE_DIR = new URL('./fixtures/', import.meta.url);
const SUBSET = new Uint8Array(readFileSync(new URL('NotoSansSC-Bold-subset.ttf', FIXTURE_DIR)));
const REFERENCE = JSON.parse(
  readFileSync(new URL('font-reference.json', FIXTURE_DIR), 'utf8'),
) as Reference;

const SHAN = '\u5C71';
const MEN = '\u95E8';
const ZERO = '0';
const EIGHT = '8';
const A = 'A';

interface GlyphFact {
  readonly advance: number;
  readonly bounds: readonly [number, number, number, number];
  readonly area: number;
  readonly contours: number;
  readonly holes: number;
  readonly verticalAdvance: number;
  readonly topSideBearing: number;
}

interface Reference {
  readonly grid: { size: number; x0: number; x1: number; y0: number; y1: number };
  readonly glyphs: Readonly<Record<string, GlyphFact>>;
  readonly rasters: Readonly<Record<string, readonly string[]>>;
}

function must<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error('expected ok result');
  return result.value;
}

function failure<T, E>(result: Result<T, E>): E {
  if (result.ok) throw new Error('expected an error result');
  return result.error;
}

function reasonOf(error: ModelingError): unknown {
  return error.detail?.reason;
}

function font(): TrueTypeFont {
  return must(parseTrueTypeFont(SUBSET));
}

function regionOf(text: string, options?: Parameters<typeof fontRegion>[2]): FontRegionResult {
  return must(fontRegion(font(), text, options));
}

function ringArea(ring: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a !== undefined && b !== undefined) sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function glyphIdOf(f: TrueTypeFont, ch: string): number {
  return must(f.glyphId(ch.codePointAt(0) ?? 0));
}

/** Builds a minimal sfnt with the given tables; used for synthetic composite and malformed cases. */
function sfnt(tables: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const tags = Object.keys(tables).sort();
  const headerSize = 12 + tags.length * 16;
  let total = headerSize;
  for (const tag of tags) total += pad4(tables[tag]?.length ?? 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tags.length);
  let offset = headerSize;
  tags.forEach((tag, i) => {
    const body = tables[tag] ?? new Uint8Array();
    const base = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[base + k] = tag.charCodeAt(k);
    view.setUint32(base + 8, offset);
    view.setUint32(base + 12, body.length);
    out.set(body, offset);
    offset += pad4(body.length);
  });
  return out;
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

function bytes(size: number, write: (view: DataView) => void): Uint8Array {
  const out = new Uint8Array(size);
  write(new DataView(out.buffer));
  return out;
}

/**
 * Synthetic font: glyph 1 is a 0..1000 square, glyph 2 is a composite of glyph 1 with
 * word offsets (100, 200) and scale 0.5, glyph 3 references itself (recursion), and cmap
 * maps 'A' -> 1 and 'B' -> 2. `pointMatch` makes glyph 2 use point matching instead of XY
 * offsets; `variable` adds an fvar table; `vmtx` adds vertical metrics.
 */
function syntheticFont(options: { variable?: boolean; pointMatch?: boolean; vmtx?: boolean }) {
  const square = bytes(34, (v) => {
    v.setInt16(0, 1);
    v.setInt16(2, 0);
    v.setInt16(4, 0);
    v.setInt16(6, 1000);
    v.setInt16(8, 1000);
    v.setUint16(10, 3);
    v.setUint16(12, 0);
    for (let i = 0; i < 4; i++) v.setUint8(14 + i, 1);
    [0, 1000, 0, -1000].forEach((d, i) => {
      v.setInt16(18 + i * 2, d);
    });
    [0, 0, 1000, 0].forEach((d, i) => {
      v.setInt16(26 + i * 2, d);
    });
  });
  const composite = bytes(20, (v) => {
    v.setInt16(0, -1);
    v.setInt16(2, 100);
    v.setInt16(4, 200);
    v.setInt16(6, 600);
    v.setInt16(8, 700);
    v.setUint16(10, options.pointMatch ? 0x0001 | 0x8 : 0x0001 | 0x2 | 0x8);
    v.setUint16(12, 1);
    v.setInt16(14, 100);
    v.setInt16(16, 200);
    v.setInt16(18, 8192);
  });
  const selfRef = bytes(18, (v) => {
    v.setInt16(0, -1);
    v.setUint16(10, 0x0001 | 0x2);
    v.setUint16(12, 3);
  });
  const glyphs = [new Uint8Array(0), square, composite, selfRef];
  const glyfParts: number[] = [];
  const offsets: number[] = [];
  for (const g of glyphs) {
    offsets.push(glyfParts.length);
    for (const b of g) glyfParts.push(b);
    while (glyfParts.length % 2 !== 0) glyfParts.push(0);
  }
  offsets.push(glyfParts.length);
  const glyf = Uint8Array.from(glyfParts);
  const loca = bytes(offsets.length * 2, (v) => {
    offsets.forEach((o, i) => {
      v.setUint16(i * 2, o / 2);
    });
  });
  const head = bytes(54, (v) => {
    v.setUint32(12, 0x5f0f3cf5);
    v.setUint16(18, 1000);
    v.setInt16(50, 0);
  });
  const maxp = bytes(6, (v) => {
    v.setUint32(0, 0x00005000);
    v.setUint16(4, glyphs.length);
  });
  const hhea = bytes(36, (v) => {
    v.setInt16(4, 800);
    v.setInt16(6, -200);
    v.setUint16(34, glyphs.length);
  });
  const hmtx = bytes(glyphs.length * 4, (v) => {
    for (let i = 0; i < glyphs.length; i++) v.setUint16(i * 4, 1000);
  });
  // cmap header (12 bytes) followed by a format 4 subtable with segments 0x41..0x42 -> glyphs 1..2
  // through idDelta, and the terminating 0xffff segment.
  const cmap = bytes(44, (v) => {
    v.setUint16(2, 1);
    v.setUint16(4, 3);
    v.setUint16(6, 1);
    v.setUint32(8, 12);
    v.setUint16(12, 4);
    v.setUint16(14, 32);
    v.setUint16(18, 4);
    v.setUint16(26, 0x42);
    v.setUint16(28, 0xffff);
    v.setUint16(32, 0x41);
    v.setUint16(34, 0xffff);
    v.setUint16(36, (1 - 0x41) & 0xffff);
    v.setUint16(38, 1);
  });
  const tables: Record<string, Uint8Array> = { head, maxp, hhea, hmtx, loca, glyf, cmap };
  if (options.vmtx) tables.vmtx = bytes(glyphs.length * 4, () => {});
  if (options.variable) tables.fvar = new Uint8Array(16);
  return sfnt(tables);
}

describe('TrueType header and cmap', () => {
  it('reads the static subset header', () => {
    const f = font();
    expect(f.unitsPerEm).toBe(1000);
    expect(f.glyphCount).toBe(54);
    expect(f.variable).toBe(false);
    expect(f.hasVerticalMetrics).toBe(true);
    expect(f.ascender).toBe(1160);
    expect(f.descender).toBe(-288);
  });

  it('maps code points through cmap and reports unmapped characters as glyph 0', () => {
    const f = font();
    expect(must(f.glyphId(0x30))).toBeGreaterThan(0);
    expect(must(f.glyphId(0x61))).toBe(0);
    expect(must(f.glyphId(0x10ffff))).toBe(0);
  });

  it('matches fontTools advances, vertical metrics and bounds', () => {
    const f = font();
    for (const [ch, fact] of Object.entries(REFERENCE.glyphs)) {
      const info = must(f.glyphInfo(glyphIdOf(f, ch)));
      expect(info.advance).toBe(fact.advance);
      expect(info.verticalAdvance).toBe(fact.verticalAdvance);
      expect(info.verticalOrigin).toBeCloseTo((info.bounds?.[3] ?? 0) + fact.topSideBearing, 6);
      // glyf header boxes can differ from fontTools' tight curve bounds by a few units.
      expect(Math.abs((info.bounds?.[0] ?? 0) - fact.bounds[0])).toBeLessThan(2);
      expect(Math.abs((info.bounds?.[1] ?? 0) - fact.bounds[1])).toBeLessThan(2);
      expect(Math.abs((info.bounds?.[2] ?? 0) - fact.bounds[2])).toBeLessThan(2);
      expect(Math.abs((info.bounds?.[3] ?? 0) - fact.bounds[3])).toBeLessThan(2);
    }
  });

  it('flattened glyph areas agree with fontTools AreaPen within 0.2 percent', () => {
    const f = font();
    for (const [ch, fact] of Object.entries(REFERENCE.glyphs)) {
      const rings = must(f.glyphRings(glyphIdOf(f, ch), 0.01));
      const total = rings.reduce((sum, ring) => sum + ringArea(ring), 0);
      expect(Math.abs(Math.abs(total) - Math.abs(fact.area)) / Math.abs(fact.area)).toBeLessThan(
        0.002,
      );
    }
  });

  it('returns the reference contour count for every glyph', () => {
    const f = font();
    for (const [ch, fact] of Object.entries(REFERENCE.glyphs)) {
      expect(must(f.glyphRings(glyphIdOf(f, ch), 0.01)).length).toBe(fact.contours);
    }
  });
});

describe('fontRegion shapes', () => {
  it('resolves overlapping contours by nonzero winding into closed shapes', () => {
    for (const ch of [ZERO, EIGHT, A, SHAN, MEN]) {
      const { region } = regionOf(ch);
      expect(region.length).toBeGreaterThanOrEqual(1);
      for (const shape of region) expect(ringArea(shape.outer)).toBeGreaterThan(0);
    }
  });

  it('normalises outer loops counter-clockwise and holes clockwise', () => {
    const { region } = regionOf(ZERO);
    for (const shape of region) {
      expect(ringArea(shape.outer)).toBeGreaterThan(0);
      for (const hole of shape.holes ?? []) expect(ringArea(hole)).toBeLessThan(0);
    }
  });

  it('reports missing characters and skips them without drawing', () => {
    const drawn = regionOf(SHAN).region.length;
    const result = regionOf(`a${SHAN}a`);
    expect(result.missing).toEqual(['a']);
    expect(result.region.length).toBe(drawn);
  });

  it('is deterministic for identical input', () => {
    expect(regionOf(`${ZERO}${SHAN}`)).toEqual(regionOf(`${ZERO}${SHAN}`));
  });

  it('places consecutive glyphs by their horizontal advance', () => {
    const solo = region2d.bounds(regionOf(EIGHT).region);
    const pair = region2d.bounds(regionOf(`${A}${EIGHT}`).region);
    const advance = REFERENCE.glyphs[A]?.advance ?? 0;
    expect((pair?.[2] ?? 0) - (solo?.[2] ?? 0)).toBeCloseTo(advance / 1000, 9);
  });

  it('centers each line on the origin when align is center', () => {
    const start = region2d.bounds(regionOf(`${A}${EIGHT}`).region);
    const centered = region2d.bounds(regionOf(`${A}${EIGHT}`, { align: 'center' }).region);
    const width =
      (REFERENCE.glyphs[A]?.advance ?? 0) / 1000 + (REFERENCE.glyphs[EIGHT]?.advance ?? 0) / 1000;
    expect((start?.[0] ?? 0) - (centered?.[0] ?? 0)).toBeCloseTo(width / 2, 9);
  });

  it('stacks a vertical glyph using the vertical origin', () => {
    const fact = REFERENCE.glyphs[SHAN];
    expect(fact).toBeDefined();
    if (fact === undefined) return;
    const column = region2d.bounds(regionOf(SHAN, { direction: 'vertical' }).region);
    // Origin sits at -verticalOrigin; top is -topSideBearing, bottom is yMin - yMax - tsb.
    expect(column?.[3]).toBeCloseTo(-fact.topSideBearing / 1000, 2);
    expect(column?.[1]).toBeCloseTo(
      (fact.bounds[1] - fact.bounds[3] - fact.topSideBearing) / 1000,
      2,
    );
    expect(column?.[0]).toBeCloseTo(-0.5 + fact.bounds[0] / 1000, 2);
    expect(column?.[2]).toBeCloseTo(-0.5 + fact.bounds[2] / 1000, 2);
  });

  it('moves the next vertical column leftward on a newline', () => {
    const men = REFERENCE.glyphs[MEN];
    expect(men).toBeDefined();
    if (men === undefined) return;
    const bounds = region2d.bounds(regionOf(`${SHAN}\n${MEN}`, { direction: 'vertical' }).region);
    // Column pitch is lineSpacing * size = 1.2; the second column is centred at -1.2 - 0.5.
    expect(bounds?.[0]).toBeCloseTo(-1.2 - 0.5 + men.bounds[0] / 1000, 2);
  });
});

describe('composite and malformed input', () => {
  it('applies component scale and offset to a simple glyph', () => {
    const f = must(parseTrueTypeFont(syntheticFont({})));
    const rings = must(f.glyphRings(2, 1e-6));
    expect(rings).toHaveLength(1);
    const xs = rings[0]?.map((p) => p[0]) ?? [];
    const ys = rings[0]?.map((p) => p[1]) ?? [];
    expect(Math.min(...xs)).toBeCloseTo(100, 6);
    expect(Math.max(...xs)).toBeCloseTo(600, 6);
    expect(Math.min(...ys)).toBeCloseTo(200, 6);
    expect(Math.max(...ys)).toBeCloseTo(700, 6);
  });

  it('maps a synthetic cmap onto synthetic glyphs', () => {
    const f = must(parseTrueTypeFont(syntheticFont({})));
    expect(must(f.glyphId(0x41))).toBe(1);
    expect(must(f.glyphId(0x42))).toBe(2);
    expect(must(f.glyphId(0x43))).toBe(0);
  });

  it('refuses point-matching composites with a closed reason', () => {
    const f = must(parseTrueTypeFont(syntheticFont({ pointMatch: true })));
    expect(reasonOf(failure(f.glyphRings(2, 0.01)))).toBe('point-matching-composite');
  });

  it('bounds self-referencing composite recursion', () => {
    const f = must(parseTrueTypeFont(syntheticFont({})));
    expect(reasonOf(failure(f.glyphRings(3, 0.01)))).toBe('recursion-limit');
  });

  it('parses variable fonts but refuses them for text layout', () => {
    const f = must(parseTrueTypeFont(syntheticFont({ variable: true })));
    expect(f.variable).toBe(true);
    expect(reasonOf(failure(fontRegion(f, 'A')))).toBe('variable-font');
  });

  it('refuses vertical layout without vmtx', () => {
    const f = must(parseTrueTypeFont(syntheticFont({})));
    expect(f.hasVerticalMetrics).toBe(false);
    const error = failure(fontRegion(f, 'A', { direction: 'vertical' }));
    expect(error.code).toBe('model-capability-unavailable');
    expect(reasonOf(error)).toBe('missing-vertical-metrics');
  });

  it('classifies non-TrueType containers by reason', () => {
    const cases: [Uint8Array, string][] = [
      [Uint8Array.from([0x74, 0x74, 0x63, 0x66, 0, 0, 0, 0, 0, 0, 0, 0]), 'collection'],
      [Uint8Array.from([0x4f, 0x54, 0x54, 0x4f, 0, 0, 0, 0, 0, 0, 0, 0]), 'cff-outlines'],
      [Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 'not-sfnt'],
    ];
    for (const [data, reason] of cases) {
      expect(reasonOf(failure(parseTrueTypeFont(data)))).toBe(reason);
    }
  });

  it('returns structured results for truncations and corrupt bytes without throwing', () => {
    const started = Date.now();
    for (let cut = 0; cut < SUBSET.length; cut += 97) {
      expect(typeof parseTrueTypeFont(SUBSET.slice(0, cut)).ok).toBe('boolean');
    }
    let seed = 0x2f6e2b1;
    for (let round = 0; round < 200; round++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const copy = SUBSET.slice();
      copy[seed % copy.length] = (seed >>> 8) & 0xff;
      const parsed = parseTrueTypeFont(copy);
      if (parsed.ok) {
        expect(typeof fontRegion(parsed.value, `${ZERO}${SHAN}`).ok).toBe('boolean');
      }
    }
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('stops flattening inside the segment budget', () => {
    // Glyph 8 is curve-heavy; at this tolerance its flattening exceeds the 2^20 segment budget.
    const outcome = fontRegion(font(), EIGHT, { tolerance: 1e-9 });
    expect(failure(outcome).code).toBe('model-work-budget');
  });

  it('rejects invalid layout options', () => {
    expect(failure(fontRegion(font(), 'A', { size: 0 })).code).toBe('model-invalid-argument');
    expect(failure(fontRegion(font(), 'A', { tolerance: Number.NaN })).code).toBe(
      'model-invalid-argument',
    );
  });
});

describe('host variable font', () => {
  const host = `${homedir()}/.local/share/fonts/NotoSansSC.ttf`;
  it.skipIf(!existsSync(host))(
    'is recognised as variable and refused for layout',
    () => {
      const parsed = must(parseTrueTypeFont(new Uint8Array(readFileSync(host))));
      expect(parsed.variable).toBe(true);
      expect(reasonOf(failure(fontRegion(parsed, 'A')))).toBe('variable-font');
    },
    120_000,
  );
});

describe('reference raster agreement', () => {
  it('overlaps the fontTools even-odd raster with IoU of at least 0.9 for every glyph', () => {
    const { size, x0, x1, y0, y1 } = REFERENCE.grid;
    for (const ch of [ZERO, EIGHT, A, SHAN, MEN]) {
      const shapes = regionOf(ch).region;
      const rows = REFERENCE.rasters[ch];
      expect(rows).toBeDefined();
      if (rows === undefined) continue;
      let inter = 0;
      let union = 0;
      for (let row = 0; row < size; row++) {
        const reference = rows[row] ?? '';
        const y = y0 + ((size - 1 - row + 0.5) / size) * (y1 - y0);
        for (let col = 0; col < size; col++) {
          const x = x0 + ((col + 0.5) / size) * (x1 - x0);
          const mine = region2d.contains(shapes, [x, y]);
          const theirs = reference[col] === '1';
          if (mine && theirs) inter++;
          if (mine || theirs) union++;
        }
      }
      expect(inter / union).toBeGreaterThanOrEqual(0.9);
    }
  }, 120_000);
});
