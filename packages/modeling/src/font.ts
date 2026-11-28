import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from './arrays';
import { type ModelingError, modelingError } from './errors';
import type { Point2 } from './primitives';
import type { Region2, Shape2 } from './region2d';
import { region2d } from './region2d';

/**
 * Real TrueType outlines for modeling text. The reader is bounds-checked and
 * refuses what it cannot represent exactly: CFF outlines, collections, variable
 * fonts (gvar is not applied) and point-matching composites.
 */
export type FontErrorReason =
  | 'not-sfnt'
  | 'collection'
  | 'cff-outlines'
  | 'variable-font'
  | 'point-matching-composite'
  | 'missing-vertical-metrics'
  | 'truncated'
  | 'missing-table'
  | 'malformed-table'
  | 'no-unicode-cmap'
  | 'glyph-out-of-range'
  | 'recursion-limit'
  | 'segment-budget';

export interface GlyphInfo {
  /** Horizontal advance in font units. */
  readonly advance: number;
  /** Vertical advance in font units (0 when the font has no vmtx). */
  readonly verticalAdvance: number;
  /** Vertical origin (yMax + top side bearing) in font units, 0 without vmtx or contours. */
  readonly verticalOrigin: number;
  /** Glyph bounding box [xMin, yMin, xMax, yMax] in font units, absent for empty glyphs. */
  readonly bounds?: readonly [number, number, number, number];
}

export interface TrueTypeFont {
  readonly unitsPerEm: number;
  readonly glyphCount: number;
  readonly variable: boolean;
  readonly hasVerticalMetrics: boolean;
  readonly ascender: number;
  readonly descender: number;
  glyphId(codePoint: number): Result<number, ModelingError>;
  glyphInfo(glyphId: number): Result<GlyphInfo, ModelingError>;
  /** Closed rings in font units; quadratic curves flattened to `tolerance` font units. */
  glyphRings(
    glyphId: number,
    tolerance: number,
  ): Result<readonly (readonly Point2[])[], ModelingError>;
}

export interface FontRegionOptions {
  /** Em size in region units (default 1). */
  readonly size?: number;
  /** 'horizontal' (default) or 'vertical' (columns right to left, top to bottom). */
  readonly direction?: 'horizontal' | 'vertical';
  /** Extra space between glyphs, as a fraction of size (default 0). */
  readonly tracking?: number;
  /** Line or column pitch as a fraction of size (default 1.2). */
  readonly lineSpacing?: number;
  /** 'start' (default) or 'center' per line or column. */
  readonly align?: 'start' | 'center';
  /** Maximum chord error of flattened curves in region units (default size * 1e-3). */
  readonly tolerance?: number;
}

export interface FontRegionResult {
  readonly region: Region2;
  /** Distinct characters with no glyph in the font; they are skipped, not drawn. */
  readonly missing: readonly string[];
}

const TAG_TTCF = 0x74746366;
const TAG_OTTO = 0x4f54544f;
const TAG_TRUE = 0x74727565;
const TRUETYPE_VERSION = 0x00010000;
const HEAD_MAGIC = 0x5f0f3cf5;

const ARGS_ARE_WORDS = 0x1;
const ARGS_ARE_XY = 0x2;
const WE_HAVE_A_SCALE = 0x8;
const MORE_COMPONENTS = 0x20;
const X_AND_Y_SCALE = 0x40;
const TWO_BY_TWO = 0x80;
const SCALED_COMPONENT_OFFSET = 0x800;
const UNSCALED_COMPONENT_OFFSET = 0x1000;
const ON_CURVE = 0x1;
const X_SHORT = 0x2;
const Y_SHORT = 0x4;
const REPEAT = 0x8;
const X_SAME_OR_POSITIVE = 0x10;
const Y_SAME_OR_POSITIVE = 0x20;

const MAX_COMPOSITE_DEPTH = 8;
const SEGMENT_BUDGET = 1 << 20;
const CMAP_PREFERENCE: readonly (readonly [number, number])[] = [
  [3, 10],
  [0, 4],
  [3, 1],
  [0, 3],
];

const EXPECTED: Readonly<Record<FontErrorReason, string>> = {
  'not-sfnt': 'a TrueType sfnt file (version 1.0 or true)',
  collection: 'a single-face font, not a TrueType collection',
  'cff-outlines': 'TrueType outlines (glyf), not CFF',
  'variable-font': 'a static font; variable fonts must be instanced first',
  'point-matching-composite': 'composite glyphs with XY offsets',
  'missing-vertical-metrics': 'a font with vhea and vmtx tables for vertical layout',
  truncated: 'table ranges inside the file',
  'missing-table': 'head, maxp, hhea, hmtx, loca, glyf and cmap tables',
  'malformed-table': 'well-formed table fields',
  'no-unicode-cmap': 'a format 4 or format 12 Unicode cmap subtable',
  'glyph-out-of-range': 'a glyph index in [0, glyphCount)',
  'recursion-limit': `composite nesting no deeper than ${MAX_COMPOSITE_DEPTH} levels`,
  'segment-budget': 'flattened curves within the segment budget',
};

const HINTS: Readonly<Partial<Record<FontErrorReason, string>>> = {
  collection: 'extract one face into a single-font .ttf file first',
  'cff-outlines': 'supply a TrueType (glyf) font; CFF/OpenType outlines are not read',
  'variable-font':
    'instance the font at the wanted weight first (fontTools instancer); gvar deltas are not applied',
  'point-matching-composite': 're-save the font with XY-offset composites',
  'missing-vertical-metrics': 'use direction horizontal, or supply a font with vmtx',
  'segment-budget': 'raise the tolerance or shorten the text',
};

const CAPABILITY: ReadonlySet<FontErrorReason> = new Set([
  'collection',
  'cff-outlines',
  'variable-font',
  'point-matching-composite',
  'missing-vertical-metrics',
]);

class FontFailure {
  readonly reason: FontErrorReason;
  readonly detail: Record<string, unknown>;

  constructor(reason: FontErrorReason, detail: Record<string, unknown> = {}) {
    this.reason = reason;
    this.detail = detail;
  }
}

function toError(failure: FontFailure): ModelingError {
  const code =
    failure.reason === 'segment-budget'
      ? 'model-work-budget'
      : CAPABILITY.has(failure.reason)
        ? 'model-capability-unavailable'
        : 'model-invalid-argument';
  return modelingError(
    code,
    EXPECTED[failure.reason],
    { reason: failure.reason, ...failure.detail },
    HINTS[failure.reason],
  );
}

function guard<T>(run: () => T): Result<T, ModelingError> {
  try {
    return ok(run());
  } catch (cause) {
    if (cause instanceof FontFailure) return err(toError(cause));
    throw cause;
  }
}

function inRange(total: number, offset: number, size: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0 && size >= 0 && offset + size <= total;
}

class Table {
  readonly view: DataView;
  readonly tag: string;
  readonly offset: number;
  readonly length: number;

  constructor(view: DataView, tag: string, offset: number, length: number) {
    this.view = view;
    this.tag = tag;
    this.offset = offset;
    this.length = length;
  }

  at(rel: number, size: number): number {
    if (!inRange(this.length, rel, size)) {
      throw new FontFailure('malformed-table', { table: this.tag, offset: rel, size });
    }
    return this.offset + rel;
  }

  u8(rel: number): number {
    return this.view.getUint8(this.at(rel, 1));
  }

  i8(rel: number): number {
    return this.view.getInt8(this.at(rel, 1));
  }

  u16(rel: number): number {
    return this.view.getUint16(this.at(rel, 2));
  }

  i16(rel: number): number {
    return this.view.getInt16(this.at(rel, 2));
  }

  u32(rel: number): number {
    return this.view.getUint32(this.at(rel, 4));
  }

  f2dot14(rel: number): number {
    return this.view.getInt16(this.at(rel, 2)) / 16384;
  }

  sub(rel: number, length: number): Table {
    return new Table(this.view, this.tag, this.at(rel, length), length);
  }
}

interface RawContour {
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly on: readonly boolean[];
}

interface Budget {
  segments: number;
}

interface Directory {
  readonly tables: ReadonlyMap<string, Table>;
}

function requireTable(dir: Directory, tag: string): Table {
  const table = dir.tables.get(tag);
  if (table === undefined) throw new FontFailure('missing-table', { table: tag });
  return table;
}

function readDirectory(view: DataView): Directory {
  const whole = new Table(view, 'file', 0, view.byteLength);
  const count = whole.u16(4);
  whole.at(12, count * 16);
  const tables = new Map<string, Table>();
  for (let i = 0; i < count; i++) {
    const base = 12 + i * 16;
    const tag = String.fromCharCode(
      whole.u8(base),
      whole.u8(base + 1),
      whole.u8(base + 2),
      whole.u8(base + 3),
    );
    const offset = whole.u32(base + 8);
    const length = whole.u32(base + 12);
    if (!inRange(view.byteLength, offset, length)) {
      throw new FontFailure('truncated', { table: tag, offset, length });
    }
    if (!tables.has(tag)) tables.set(tag, new Table(view, tag, offset, length));
  }
  return { tables };
}

function readCmap(cmap: Table): (codePoint: number) => number {
  const count = cmap.u16(2);
  let chosen: Table | undefined;
  for (const [platform, encoding] of CMAP_PREFERENCE) {
    for (let i = 0; i < count && chosen === undefined; i++) {
      const base = 4 + i * 8;
      if (cmap.u16(base) !== platform || cmap.u16(base + 2) !== encoding) continue;
      const offset = cmap.u32(base + 4);
      const sub = cmap.sub(offset, cmap.length - offset);
      const format = sub.u16(0);
      if (format === 4 || format === 12) chosen = sub;
    }
    if (chosen !== undefined) break;
  }
  if (chosen === undefined) throw new FontFailure('no-unicode-cmap');
  return chosen.u16(0) === 4 ? format4Lookup(chosen) : format12Lookup(chosen);
}

function format4Lookup(sub: Table): (codePoint: number) => number {
  const segX2 = sub.u16(6);
  const segments = segX2 >> 1;
  if (segments === 0) throw new FontFailure('no-unicode-cmap', { format: 4 });
  const endCodes = 14;
  const startCodes = endCodes + segX2 + 2;
  const deltas = startCodes + segX2;
  const rangeOffsets = deltas + segX2;
  sub.at(rangeOffsets, segX2);
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    let lo = 0;
    let hi = segments;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sub.u16(endCodes + mid * 2) < codePoint) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= segments) return 0;
    const start = sub.u16(startCodes + lo * 2);
    if (codePoint < start) return 0;
    const delta = sub.u16(deltas + lo * 2);
    const rangeOffset = sub.u16(rangeOffsets + lo * 2);
    if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
    const glyph = sub.u16(rangeOffsets + lo * 2 + rangeOffset + (codePoint - start) * 2);
    return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
  };
}

function format12Lookup(sub: Table): (codePoint: number) => number {
  const groups = sub.u32(12);
  sub.at(16, groups * 12);
  return (codePoint) => {
    let lo = 0;
    let hi = groups;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sub.u32(16 + mid * 12 + 4) < codePoint) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= groups) return 0;
    const base = 16 + lo * 12;
    const start = sub.u32(base);
    if (codePoint < start) return 0;
    return sub.u32(base + 8) + (codePoint - start);
  };
}

function signedArea(ring: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a === undefined || b === undefined) continue;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function spend(budget: Budget, segments: number): void {
  budget.segments += segments;
  if (budget.segments > SEGMENT_BUDGET) {
    throw new FontFailure('segment-budget', { limit: SEGMENT_BUDGET });
  }
}

function flattenContour(contour: RawContour, tolerance: number, budget: Budget): Point2[] {
  const count = contour.on.length;
  if (count === 0) return [];
  const firstOn = contour.on.indexOf(true);
  const seq: { x: number; y: number; on: boolean }[] = [];
  if (firstOn >= 0) {
    for (let k = 0; k <= count; k++) {
      const i = (firstOn + k) % count;
      seq.push({ x: contour.x[i] ?? 0, y: contour.y[i] ?? 0, on: contour.on[i] === true });
    }
  } else {
    const p0 = { x: contour.x[0] ?? 0, y: contour.y[0] ?? 0 };
    const p1 = { x: contour.x[1 % count] ?? 0, y: contour.y[1 % count] ?? 0 };
    const start = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2, on: true };
    seq.push(start);
    for (let i = 1; i <= count; i++) {
      const j = i % count;
      seq.push({ x: contour.x[j] ?? 0, y: contour.y[j] ?? 0, on: false });
    }
    seq.push(start);
  }

  const out: Point2[] = [];
  const first = seq[0];
  if (first === undefined) return [];
  let cx = first.x;
  let cy = first.y;
  out.push([cx, cy]);
  let hasControl = false;
  let kx = 0;
  let ky = 0;
  const quad = (x1: number, y1: number, x2: number, y2: number): void => {
    const dx = cx - 2 * x1 + x2;
    const dy = cy - 2 * y1 + y2;
    const n = Math.max(1, Math.ceil(Math.sqrt(Math.sqrt(dx * dx + dy * dy) / (4 * tolerance))));
    spend(budget, n);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      out.push([
        u * u * cx + 2 * u * t * x1 + t * t * x2,
        u * u * cy + 2 * u * t * y1 + t * t * y2,
      ]);
    }
    cx = x2;
    cy = y2;
  };
  for (let i = 1; i < seq.length; i++) {
    const point = seq[i];
    if (point === undefined) continue;
    if (point.on) {
      if (hasControl) {
        quad(kx, ky, point.x, point.y);
      } else {
        spend(budget, 1);
        out.push([point.x, point.y]);
        cx = point.x;
        cy = point.y;
      }
      hasControl = false;
    } else {
      if (hasControl) {
        quad(kx, ky, (kx + point.x) / 2, (ky + point.y) / 2);
      }
      kx = point.x;
      ky = point.y;
      hasControl = true;
    }
  }

  const ring: Point2[] = [];
  for (const p of out) {
    const last = ring[ring.length - 1];
    if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) ring.push(p);
  }
  const head = ring[0];
  const tail = ring[ring.length - 1];
  if (
    ring.length > 1 &&
    head !== undefined &&
    tail !== undefined &&
    head[0] === tail[0] &&
    head[1] === tail[1]
  ) {
    ring.pop();
  }
  return ring.length >= 3 ? ring : [];
}

function readFont(bytes: Uint8Array): TrueTypeFont {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const whole = new Table(view, 'file', 0, bytes.byteLength);
  const sfnt = whole.u32(0);
  if (sfnt === TAG_TTCF) throw new FontFailure('collection');
  if (sfnt === TAG_OTTO) throw new FontFailure('cff-outlines', { sfnt: 'OTTO' });
  if (sfnt !== TRUETYPE_VERSION && sfnt !== TAG_TRUE) {
    throw new FontFailure('not-sfnt', { sfnt });
  }
  const dir = readDirectory(view);

  const head = requireTable(dir, 'head');
  if (head.u32(12) !== HEAD_MAGIC) throw new FontFailure('malformed-table', { table: 'head' });
  const unitsPerEm = head.u16(18);
  if (unitsPerEm < 16 || unitsPerEm > 16384) {
    throw new FontFailure('malformed-table', { table: 'head', unitsPerEm });
  }
  const locLong = head.i16(50);
  if (locLong !== 0 && locLong !== 1) {
    throw new FontFailure('malformed-table', { table: 'head', indexToLocFormat: locLong });
  }

  const maxp = requireTable(dir, 'maxp');
  const glyphCount = maxp.u16(4);
  if (glyphCount < 1) throw new FontFailure('malformed-table', { table: 'maxp' });

  const hhea = requireTable(dir, 'hhea');
  const ascender = hhea.i16(4);
  const descender = hhea.i16(6);
  const hMetricCount = hhea.u16(34);
  if (hMetricCount < 1 || hMetricCount > glyphCount) {
    throw new FontFailure('malformed-table', { table: 'hhea', hMetricCount });
  }
  const hmtx = requireTable(dir, 'hmtx');
  hmtx.at(0, hMetricCount * 4);
  const horizontalAdvance = (gid: number): number => hmtx.u16(Math.min(gid, hMetricCount - 1) * 4);

  const vhea = dir.tables.get('vhea');
  const vmtx = dir.tables.get('vmtx');
  let verticalMetricCount = 0;
  if (vhea !== undefined && vmtx !== undefined) {
    verticalMetricCount = vhea.u16(34);
    if (verticalMetricCount < 1 || verticalMetricCount > glyphCount) {
      throw new FontFailure('malformed-table', { table: 'vhea', verticalMetricCount });
    }
    vmtx.at(0, verticalMetricCount * 4);
  }
  const hasVertical = vmtx !== undefined && verticalMetricCount > 0;
  const verticalAdvance = (gid: number): number =>
    hasVertical && vmtx !== undefined ? vmtx.u16(Math.min(gid, verticalMetricCount - 1) * 4) : 0;
  const topSideBearing = (gid: number): number => {
    if (!hasVertical || vmtx === undefined) return 0;
    return gid < verticalMetricCount
      ? vmtx.i16(gid * 4 + 2)
      : vmtx.i16(verticalMetricCount * 4 + (gid - verticalMetricCount) * 2);
  };

  const loca = requireTable(dir, 'loca');
  const glyf = dir.tables.get('glyf');
  if (glyf === undefined) {
    if (dir.tables.has('CFF ') || dir.tables.has('CFF2')) throw new FontFailure('cff-outlines');
    throw new FontFailure('missing-table', { table: 'glyf' });
  }
  const glyphOffset = (gid: number): number =>
    locLong === 1 ? loca.u32(gid * 4) : loca.u16(gid * 2) * 2;
  loca.at(0, (glyphCount + 1) * (locLong === 1 ? 4 : 2));

  const cmapTable = requireTable(dir, 'cmap');
  const lookup = readCmap(cmapTable);
  const variable = dir.tables.has('fvar');

  const glyphBox = (glyphStart: number): readonly [number, number, number, number] | undefined => {
    if (glyphStart >= glyf.length) return undefined;
    const contours = glyf.i16(glyphStart);
    if (contours === 0) return undefined;
    return [
      glyf.i16(glyphStart + 2),
      glyf.i16(glyphStart + 4),
      glyf.i16(glyphStart + 6),
      glyf.i16(glyphStart + 8),
    ];
  };

  const glyphRange = (gid: number): readonly [number, number] => {
    if (!Number.isInteger(gid) || gid < 0 || gid >= glyphCount) {
      throw new FontFailure('glyph-out-of-range', { glyphId: gid, glyphCount });
    }
    const start = glyphOffset(gid);
    const end = glyphOffset(gid + 1);
    if (end < start || end > glyf.length) {
      throw new FontFailure('malformed-table', { table: 'loca', glyphId: gid });
    }
    return [start, end];
  };

  const readContours = (gid: number, depth: number): RawContour[] => {
    if (depth > MAX_COMPOSITE_DEPTH) throw new FontFailure('recursion-limit', { glyphId: gid });
    const [start, end] = glyphRange(gid);
    if (start === end) return [];
    const contourCount = glyf.i16(start);
    if (contourCount >= 0) return simpleGlyph(start, contourCount, end);
    return compositeGlyph(start, depth);
  };

  const simpleGlyph = (start: number, contourCount: number, end: number): RawContour[] => {
    if (contourCount === 0) return [];
    const endPoints: number[] = [];
    let cursor = start + 10;
    for (let i = 0; i < contourCount; i++) {
      const endPoint = glyf.u16(cursor);
      if (endPoints.length > 0 && endPoint < (endPoints[endPoints.length - 1] ?? 0) + 1) {
        throw new FontFailure('malformed-table', { table: 'glyf', reason: 'endpoints' });
      }
      endPoints.push(endPoint);
      cursor += 2;
    }
    const pointCount = (endPoints[endPoints.length - 1] ?? 0) + 1;
    const instructionLength = glyf.u16(cursor);
    cursor += 2 + instructionLength;
    const flags = new Uint8Array(pointCount);
    for (let i = 0; i < pointCount; ) {
      const flag = glyf.u8(cursor);
      cursor += 1;
      flags[i++] = flag;
      if (flag & REPEAT) {
        const repeat = glyf.u8(cursor);
        cursor += 1;
        for (let k = 0; k < repeat && i < pointCount; k++) flags[i++] = flag;
      }
    }
    const xs = new Array<number>(pointCount);
    const ys = new Array<number>(pointCount);
    let x = 0;
    for (let i = 0; i < pointCount; i++) {
      const flag = flags[i] ?? 0;
      if (flag & X_SHORT) {
        const d = glyf.u8(cursor);
        cursor += 1;
        x += flag & X_SAME_OR_POSITIVE ? d : -d;
      } else if (!(flag & X_SAME_OR_POSITIVE)) {
        x += glyf.i16(cursor);
        cursor += 2;
      }
      xs[i] = x;
    }
    let y = 0;
    for (let i = 0; i < pointCount; i++) {
      const flag = flags[i] ?? 0;
      if (flag & Y_SHORT) {
        const d = glyf.u8(cursor);
        cursor += 1;
        y += flag & Y_SAME_OR_POSITIVE ? d : -d;
      } else if (!(flag & Y_SAME_OR_POSITIVE)) {
        y += glyf.i16(cursor);
        cursor += 2;
      }
      ys[i] = y;
    }
    if (cursor > end)
      throw new FontFailure('malformed-table', { table: 'glyf', reason: 'overrun' });
    const contours: RawContour[] = [];
    let first = 0;
    for (const last of endPoints) {
      const idx = Array.from({ length: last - first + 1 }, (_, k) => first + k);
      contours.push({
        x: idx.map((i) => xs[i] ?? 0),
        y: idx.map((i) => ys[i] ?? 0),
        on: idx.map((i) => ((flags[i] ?? 0) & ON_CURVE) !== 0),
      });
      first = last + 1;
    }
    return contours;
  };

  const compositeGlyph = (start: number, depth: number): RawContour[] => {
    const contours: RawContour[] = [];
    let cursor = start + 10;
    let more = true;
    while (more) {
      const flags = glyf.u16(cursor);
      const component = glyf.u16(cursor + 2);
      cursor += 4;
      if (!(flags & ARGS_ARE_XY)) throw new FontFailure('point-matching-composite');
      let dx: number;
      let dy: number;
      if (flags & ARGS_ARE_WORDS) {
        dx = glyf.i16(cursor);
        dy = glyf.i16(cursor + 2);
        cursor += 4;
      } else {
        dx = glyf.i8(cursor);
        dy = glyf.i8(cursor + 1);
        cursor += 2;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      if (flags & WE_HAVE_A_SCALE) {
        a = glyf.f2dot14(cursor);
        d = a;
        cursor += 2;
      } else if (flags & X_AND_Y_SCALE) {
        a = glyf.f2dot14(cursor);
        d = glyf.f2dot14(cursor + 2);
        cursor += 4;
      } else if (flags & TWO_BY_TWO) {
        a = glyf.f2dot14(cursor);
        b = glyf.f2dot14(cursor + 2);
        c = glyf.f2dot14(cursor + 4);
        d = glyf.f2dot14(cursor + 6);
        cursor += 8;
      }
      if ((flags & SCALED_COMPONENT_OFFSET) !== 0 && (flags & UNSCALED_COMPONENT_OFFSET) === 0) {
        const sx = a * dx + c * dy;
        const sy = b * dx + d * dy;
        dx = sx;
        dy = sy;
      }
      for (const sub of readContours(component, depth + 1)) {
        contours.push({
          x: sub.x.map((px, i) => a * px + c * (sub.y[i] ?? 0) + dx),
          y: sub.y.map((py, i) => b * (sub.x[i] ?? 0) + d * py + dy),
          on: sub.on,
        });
      }
      more = (flags & MORE_COMPONENTS) !== 0;
    }
    return contours;
  };

  const rings = (gid: number, tolerance: number, budget: Budget): Point2[][] =>
    readContours(gid, 0)
      .map((contour) => flattenContour(contour, tolerance, budget))
      .filter((ring) => ring.length > 0);

  return {
    unitsPerEm,
    glyphCount,
    variable,
    hasVerticalMetrics: hasVertical,
    ascender,
    descender,
    glyphId: (codePoint) =>
      guard(() => {
        const gid = lookup(codePoint);
        return gid < glyphCount ? gid : 0;
      }),
    glyphInfo: (gid) =>
      guard(() => {
        const [start, end] = glyphRange(gid);
        const box = end > start ? glyphBox(start) : undefined;
        const info: GlyphInfo = {
          advance: horizontalAdvance(gid),
          verticalAdvance: verticalAdvance(gid),
          verticalOrigin: box === undefined ? 0 : box[3] + topSideBearing(gid),
        };
        return box === undefined ? info : { ...info, bounds: box };
      }),
    glyphRings: (gid, tolerance) =>
      guard(() => {
        glyphRange(gid);
        return rings(gid, tolerance, { segments: 0 });
      }),
  };
}

/** Parses one static TrueType face; every read is bounds-checked and failures are structured. */
export function parseTrueTypeFont(bytes: Uint8Array): Result<TrueTypeFont, ModelingError> {
  return guard(() => readFont(bytes));
}

/**
 * TrueType fills by nonzero winding: a glyph's contours of one orientation add material and
 * those of the opposite orientation remove it, even when they overlap (Noto's A crossbar
 * overlaps the legs). The kernel's boolean union resolves that arrangement exactly, so the
 * glyph is the union of its filled contours minus the union of its counters.
 */
function classify(rings: readonly Point2[][]): Result<Region2, ModelingError> {
  const fills: Shape2[] = [];
  const counters: Shape2[] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const shape: Shape2 = { outer: [...ring] };
    if (signedArea(ring) < 0) fills.push(shape);
    else counters.push(shape);
  }
  if (fills.length === 0) return ok([]);
  const filled = region2d.union(fills, fills);
  if (!filled.ok) return filled;
  if (counters.length === 0) return ok(filled.value.region);
  const resolved = region2d.difference(filled.value.region, counters);
  if (!resolved.ok) return resolved;
  return ok(resolved.value.region);
}

/**
 * Lays out text with a parsed TrueType face into closed region shapes (outer loops CCW,
 * holes CW). Lines advance downward; vertical text stacks glyphs top to bottom in columns
 * that advance leftward. Fails on CFF, collections, variable fonts and missing vertical
 * metrics instead of approximating them.
 */
export function fontRegion(
  font: TrueTypeFont,
  text: string,
  options: FontRegionOptions = {},
): Result<FontRegionResult, ModelingError> {
  const size = options.size ?? 1;
  const tracking = options.tracking ?? 0;
  const lineSpacing = options.lineSpacing ?? 1.2;
  const tolerance = options.tolerance ?? size * 1e-3;
  const vertical = options.direction === 'vertical';
  const center = options.align === 'center';
  if (!Number.isFinite(size) || size <= 0) {
    return err(modelingError('model-invalid-argument', 'size is a positive finite length'));
  }
  if (!Number.isFinite(tracking) || !Number.isFinite(lineSpacing) || lineSpacing <= 0) {
    return err(
      modelingError('model-invalid-argument', 'tracking is finite and lineSpacing is positive'),
    );
  }
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    return err(modelingError('model-invalid-argument', 'tolerance is a positive finite length'));
  }
  if (font.variable) return err(toError(new FontFailure('variable-font')));
  if (vertical && !font.hasVerticalMetrics) {
    return err(toError(new FontFailure('missing-vertical-metrics')));
  }

  const scale = size / font.unitsPerEm;
  const step = lineSpacing * size;
  const gap = tracking * size;
  const missing: string[] = [];
  const lines: { tx: number; ty: number; gid: number }[][] = [[]];
  const lineExtent: number[] = [];
  let pen = 0;
  let line = 0;

  const finishLine = (): void => {
    const current = lines[line] ?? [];
    lineExtent.push(current.length === 0 ? 0 : Math.max(0, pen - gap));
    line++;
    lines.push([]);
    pen = 0;
  };

  for (const ch of text) {
    if (ch === '\n') {
      finishLine();
      continue;
    }
    const idResult = font.glyphId(ch.codePointAt(0) ?? 0);
    if (!idResult.ok) return idResult;
    const gid = idResult.value;
    if (gid === 0) {
      if (!missing.includes(ch)) missing.push(ch);
      continue;
    }
    const infoResult = font.glyphInfo(gid);
    if (!infoResult.ok) return infoResult;
    const info = infoResult.value;
    const current = lines[line] ?? [];
    if (vertical) {
      const column = -line * step;
      const top = -pen;
      current.push({
        tx: column - (info.advance * scale) / 2,
        ty: top - info.verticalOrigin * scale,
        gid,
      });
      pen += info.verticalAdvance * scale + gap;
    } else {
      current.push({ tx: pen, ty: -line * step, gid });
      pen += info.advance * scale + gap;
    }
    lines[line] = current;
  }
  lineExtent.push(lines[line]?.length ? Math.max(0, pen - gap) : 0);

  const region: Shape2[] = [];
  for (let l = 0; l < lines.length; l++) {
    const placed = lines[l] ?? [];
    const shift = center ? -(lineExtent[l] ?? 0) / 2 : 0;
    const dx = vertical ? 0 : shift;
    const dy = vertical ? -shift : 0;
    for (const glyph of placed) {
      const ringsResult = font.glyphRings(glyph.gid, tolerance / scale);
      if (!ringsResult.ok) return ringsResult;
      const tx = glyph.tx + dx;
      const ty = glyph.ty + dy;
      const mapped = ringsResult.value.map((ring) =>
        ring.map(([x, y]): Point2 => [tx + x * scale, ty + y * scale]),
      );
      const shapes = classify(mapped);
      if (!shapes.ok) return shapes;
      pushAll(region, shapes.value);
    }
  }
  return ok({ region, missing });
}
