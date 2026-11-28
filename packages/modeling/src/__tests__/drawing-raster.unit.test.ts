import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSvgForTest, textGeometryForTest } from '../drawing-raster';
import {
  type Drawing,
  type DrawingItem,
  drawingPng,
  drawingRaster,
  drawingSvg,
  parseTrueTypeFont,
  type RasterImage,
  resolveDrawing,
  type SheetOptions,
} from '../index';
import { fillRings, newCanvas, parseColor, type Ring } from '../raster2d';

const FONT = join(__dirname, 'fixtures', 'NotoSansSC-Bold-subset.ttf');

function resolved(d: Drawing) {
  const r = resolveDrawing(d);
  if (!r.ok) throw r.error;
  return r.value;
}

function raster(d: Drawing, options?: Parameters<typeof drawingRaster>[1]): RasterImage {
  const r = drawingRaster(resolved(d), options);
  if (!r.ok) throw r.error;
  return r.value;
}

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const ring: Drawing = {
  name: 'ring',
  views: [{ id: 'cut', section: { axis: 'z', at: 0 } }],
  items: [
    {
      id: 'outer',
      view: 'cut',
      role: 'section',
      kind: 'curve',
      curve: { kind: 'polyline', points: rect(0, 0, 1, 1) },
      closed: true,
    },
    {
      id: 'inner',
      view: 'cut',
      role: 'section',
      kind: 'curve',
      curve: { kind: 'polyline', points: rect(0.3, 0.3, 0.7, 0.7) },
      closed: true,
    },
  ],
};

const frame: Drawing = {
  name: 'frame',
  views: [{ id: 'front', ortho: 'front' }],
  items: [
    {
      id: 'box',
      view: 'front',
      role: 'silhouette',
      kind: 'curve',
      curve: { kind: 'polyline', points: rect(0, 0, 1, 1) },
      closed: true,
    },
    {
      id: 'hid',
      view: 'front',
      role: 'hidden',
      kind: 'curve',
      curve: {
        kind: 'polyline',
        points: [
          [0.2, 0.2],
          [0.8, 0.2],
        ],
      },
    },
  ],
};

/** Two views, a detail of the front (1:5 over the 1:20 sheet), a section and notes. */
const sheet: Drawing = {
  name: 'sheet',
  views: [
    { id: 'front', ortho: 'front' },
    { id: 'cut', section: { axis: 'z', at: 0 } },
    { id: 'A', of: 'front', detail: { box: [0, 0, 0.4, 0.4], scale: 200 } },
  ],
  items: [
    ...(frame.items as DrawingItem[]),
    ...(ring.items as DrawingItem[]),
    { id: 'tip', view: 'front', role: 'pivot', kind: 'point', at: [0.1, 0.1] },
    {
      id: 'call',
      view: 'front',
      role: 'break',
      kind: 'note',
      refs: ['tip'],
      text: 'shut line',
      at: [0.6, 0.6],
    },
  ],
};

const sheetOptions: SheetOptions = {
  views: ['front', 'cut', 'A'],
  columns: 3,
  sheet: { size: 'A3', title: { number: 'DWG-001', revision: 'B' } },
  scale: 50,
};

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

const isWhite = (rgba: Uint8Array, i: number) =>
  rgba[i] === 255 && rgba[i + 1] === 255 && rgba[i + 2] === 255;

/** Count of pixels that differ from the white background. */
function inkCount(img: RasterImage): number {
  let n = 0;
  for (let i = 0; i < img.rgba.length; i += 4) if (!isWhite(img.rgba, i)) n++;
  return n;
}

describe('drawingRaster output', () => {
  it('renders a non-blank image at the requested pixel width', () => {
    const img = raster(sheet, { ...sheetOptions, width: 800 });
    expect(img.width).toBe(800);
    expect(img.height).toBeGreaterThan(0);
    expect(img.rgba.length).toBe(img.width * img.height * 4);
    expect(inkCount(img)).toBeGreaterThan(1000);
  });

  it('is deterministic: the same drawing renders the same bytes', () => {
    const a = raster(sheet, { ...sheetOptions, width: 600 });
    const b = raster(sheet, { ...sheetOptions, width: 600 });
    expect(sha(a.rgba)).toBe(sha(b.rgba));
  });

  it('encodes a PNG file with the PNG signature', () => {
    const r = drawingPng(resolved(sheet), { ...sheetOptions, width: 300 });
    if (!r.ok) throw r.error;
    expect([...r.value.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('paints the requested background; white is the default', () => {
    const black = raster(frame, { width: 200, background: 'black' });
    expect(black.rgba[0]).toBe(0);
    expect(black.rgba[3]).toBe(255);
    const white = raster(frame, { width: 200 });
    expect(white.rgba[0]).toBe(255);
  });
});

describe('stroke weight and anti-aliasing', () => {
  it('draws a thicker role stroke with more ink than a thinner one', () => {
    // Silhouette is 0.5 mm, hidden is 0.25 mm: the same geometry at both weights.
    const thick = raster(
      { ...frame, items: [frame.items[0] as DrawingItem] },
      { width: 600, supersample: 1 },
    );
    const thin = raster(
      { ...frame, items: [frame.items[1] as DrawingItem] },
      { width: 600, supersample: 1 },
    );
    expect(inkCount(thick)).toBeGreaterThan(inkCount(thin));
  });

  it('produces partial coverage at stroke edges (anti-aliased, not binary)', () => {
    const img = raster(frame, { width: 300, supersample: 1 });
    let partial = 0;
    for (let i = 0; i < img.rgba.length; i += 4) {
      const v = img.rgba[i] as number;
      if (v > 0 && v < 255) partial++;
    }
    expect(partial).toBeGreaterThan(0);
  });

  it('renders a hidden role dash, which the dialect accepts on its group', () => {
    const hidden = resolved({ ...frame, items: [frame.items[1] as DrawingItem] });
    const r = drawingRaster(hidden, { width: 200 });
    expect(r.ok).toBe(true);
  });
});

describe('even-odd fills', () => {
  it('leaves a nested ring hole unfilled and fills the band', () => {
    const white = parseColor('white');
    const black = parseColor('black');
    if (white === undefined || black === undefined) throw new Error('colors');
    const canvas = newCanvas(40, 40, white);
    const outer: Ring = [
      [2, 2],
      [38, 2],
      [38, 38],
      [2, 38],
    ];
    const inner: Ring = [
      [12, 12],
      [28, 12],
      [28, 28],
      [12, 28],
    ];
    fillRings(canvas, [outer, inner], black);
    const red = (x: number, y: number) => canvas.rgba[(y * 40 + x) * 4];
    expect(red(20, 20)).toBe(255);
    expect(red(5, 5)).toBe(0);
  });
});

describe('view option', () => {
  it('renders one enlarged view: the cell fills the requested width and keeps its aspect', () => {
    const cell = raster(sheet, { ...sheetOptions, width: 1200, view: 'front' });
    // Front cell is 50 x 56 mm on the sheet: 1200 px wide gives 24 px per mm and 1344 px tall.
    expect(cell.width).toBe(1200);
    expect(cell.height).toBe(1344);
    expect(inkCount(cell)).toBeGreaterThan(200);
  });

  it('magnifies a detail by its scale over the sheet scale (true detail magnification)', () => {
    const svg = drawingSvg(resolved(sheet), sheetOptions);
    if (!svg.ok) throw svg.error;
    const parsed = parseSvgForTest(svg.value);
    if (!parsed.ok) throw parsed.error;
    const mark = parsed.value.prims.find((p) => p.kind === 'rect' && p.style.dash !== undefined);
    if (mark?.kind !== 'rect') throw new Error('detail mark not found');
    const detailCell = parsed.value.cells.get('A');
    if (detailCell === undefined) throw new Error('detail cell not found');
    // The 0.4 m detail box is 20 mm on the 1:20 sheet and 80 mm at its 1:5 detail scale.
    expect(mark.w).toBeCloseTo(0.4 * 50, 6);
    expect(detailCell.w).toBeCloseTo(0.4 * 200, 6);
    expect(detailCell.w / mark.w).toBeCloseTo(200 / 50, 6);
  });

  it('renders a detail view as its own enlarged cell', () => {
    const detail = raster(sheet, { ...sheetOptions, width: 800, view: 'A' });
    expect(detail.width).toBe(800);
    expect(inkCount(detail)).toBeGreaterThan(200);
  });

  it('rejects a view name that is not on the sheet', () => {
    const r = drawingRaster(resolved(sheet), { ...sheetOptions, view: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });
});

describe('sizing and budget', () => {
  it('rejects giving both pixelsPerMm and width', () => {
    const r = drawingRaster(resolved(frame), { pixelsPerMm: 2, width: 100 });
    expect(r.ok).toBe(false);
  });

  it('rejects a supersample outside 1..4', () => {
    const r = drawingRaster(resolved(frame), { width: 100, supersample: 5 });
    expect(r.ok).toBe(false);
  });

  it('returns a model-work-budget error with needed and allowed sizes past the pixel limit', () => {
    const r = drawingRaster(resolved(frame), { width: 20000, supersample: 4 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-work-budget');
    const detail = r.error.detail ?? {};
    expect(typeof detail.allowed).toBe('number');
    expect(detail.needed as number).toBeGreaterThan(detail.allowed as number);
  });
});

describe('text', () => {
  it('draws text from font outlines when a font is supplied', () => {
    const font = parseTrueTypeFont(new Uint8Array(readFileSync(FONT)));
    if (!font.ok) throw font.error;
    const withFont = raster(sheet, { ...sheetOptions, width: 1200, font: font.value });
    const without = raster(sheet, { ...sheetOptions, width: 1200 });
    expect(sha(withFont.rgba)).not.toBe(sha(without.rgba));
    expect(inkCount(withFont)).toBeGreaterThan(0);
  });

  it('falls back to the ASCII stroke font when no font is given', () => {
    const img = raster(sheet, { ...sheetOptions, width: 1200 });
    expect(inkCount(img)).toBeGreaterThan(0);
  });
});

describe('SVG dialect (drawingRaster consumes exactly what drawingSvg emits)', () => {
  it('accepts the sheet writer output without error', () => {
    const svg = drawingSvg(resolved(sheet), sheetOptions);
    if (!svg.ok) throw svg.error;
    expect(parseSvgForTest(svg.value).ok).toBe(true);
  });

  it('fails with a structured error naming an unsupported element', () => {
    const parsed = parseSvgForTest(
      '<svg xmlns="x" width="10mm" height="10mm" viewBox="0 0 10 10"><ellipse cx="1" cy="1" rx="1" ry="1"/></svg>',
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('model-invalid-argument');
    expect(parsed.error.detail?.element).toBe('ellipse');
  });

  it('fails with a structured error naming an unsupported attribute', () => {
    const parsed = parseSvgForTest(
      '<svg xmlns="x" width="10mm" height="10mm" viewBox="0 0 10 10"><rect x="1" y="1" width="2" height="2" transform="rotate(5)"/></svg>',
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.detail?.element).toBe('rect');
    expect(parsed.error.detail?.attribute).toBe('transform');
  });
});

describe('text coverage (no character is dropped)', () => {
  const base = {
    stroke: undefined,
    strokeWidth: 1,
    dash: undefined,
    fill: 'black',
    fontSize: 6,
    bold: false,
  } as const;
  const textItem = (text: string, anchor: 'start' | 'middle' = 'start') => ({
    kind: 'text' as const,
    x: 0,
    y: 0,
    text,
    style: { ...base, anchor },
  });

  it('draws non-empty ink for every printable ASCII character and the diameter, degree, plus-minus and times symbols', () => {
    const chars = [
      ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)),
      '\u00d8',
      '°',
      '±',
      '×',
    ];
    for (const ch of chars) {
      if (ch === ' ') continue;
      const out = textGeometryForTest(textItem(ch), undefined);
      expect(out.ok, `glyph ${JSON.stringify(ch)}`).toBe(true);
      if (!out.ok) continue;
      const ink = out.value.rings.length + out.value.lines.length;
      expect(ink, `ink for ${JSON.stringify(ch)}`).toBeGreaterThan(0);
    }
  });

  it('lays out "1:2" with each glyph at its own pen position (advance 6 grid units)', () => {
    const out = textGeometryForTest(textItem('1:2'), undefined);
    if (!out.ok) throw out.error;
    // Cap height 6 * 0.72 = 4.32 over a 6-unit grid: unit 0.72, advance 6 * 0.72 = 4.32 mm.
    // The first stroke of each glyph starts at its pen: "1" at 0.72 (grid x 1), ":" at 4.32 + 0.72,
    // "2" at 2 * 4.32 + 0.72 (its own grid x 0 at the pen). Check the glyph-start edges.
    const starts = out.value.lines.map((line) => Math.min(...line.map(([x]) => x)));
    const first = Math.min(...starts);
    const pen = 6 * 0.72;
    expect(first).toBeCloseTo(0.72, 6);
    // "2" sits at pen index 2 and its own grid x starts at 0, so its leftmost stroke is at 2 * pen.
    expect(Math.max(...starts)).toBeCloseTo(2 * pen, 6);
    const pens = new Set(starts.map((x) => Math.floor(x / pen + 1e-6)));
    expect(pens.size).toBe(3);
  });

  it('errors with the code point when no font or raster glyph draws a character', () => {
    const out = textGeometryForTest(textItem('a\u9f98'), undefined);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('model-invalid-argument');
    expect(out.error.detail?.codePoint).toBe(0x9f98);
  });

  it('errors for a CJK character the font does not cover, naming it', () => {
    const font = parseTrueTypeFont(new Uint8Array(readFileSync(FONT)));
    if (!font.ok) throw font.error;
    const out = textGeometryForTest(textItem('\u9f98'), font.value);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.detail?.codePoint).toBe(0x9f98);
  });
});

describe('exact circles and small text', () => {
  const hole: Drawing = {
    name: 'hole',
    views: [
      { id: 'front', ortho: 'front' },
      { id: 'A', of: 'front', detail: { box: [0.11, 0.03, 0.17, 0.09], scale: 1000 } },
    ],
    items: [
      {
        id: 'plate',
        view: 'front',
        role: 'silhouette',
        kind: 'curve',
        curve: { kind: 'polyline', points: rect(0, 0, 0.2, 0.12) },
        closed: true,
      },
      {
        id: 'hole',
        view: 'front',
        role: 'visible',
        kind: 'curve',
        curve: { kind: 'arc', center: [0.14, 0.06], radius: 0.015, from: 0, to: 2 * Math.PI },
        closed: true,
        tolerance: 0.00005,
      },
    ],
  };
  const resolved = () => {
    const r = resolveDrawing(hole);
    if (!r.ok) throw r.error;
    return r.value;
  };

  it('emits a solid full-circle arc as an exact <circle>, never a facet polygon', () => {
    const svg = drawingSvg(resolved(), { ...sheetOptions, views: ['front', 'A'] });
    if (!svg.ok) throw svg.error;
    expect(svg.value).toMatch(/<circle data-id="hole" cx="[\d.]+" cy="[\d.]+" r="[\d.]+"\/>/);
    expect(svg.value).not.toMatch(/<polygon data-id="hole"/);
  });

  it('keeps the exact circle inside a detail box that contains the whole circle', () => {
    const svg = drawingSvg(resolved(), { ...sheetOptions, views: ['front', 'A'] });
    if (!svg.ok) throw svg.error;
    expect(svg.value).toMatch(/<circle data-id="hole" cx="[\d.]+" cy="[\d.]+" r="15\.00"\/>/);
    expect(svg.value).not.toMatch(/<polyline data-id="hole"|<polygon data-id="hole"/);
  });

  it('strokes a stroke-only circle as a ring, not a filled disk', () => {
    const img = drawingRaster(resolved(), {
      ...sheetOptions,
      views: ['front', 'A'],
      width: 1600,
      view: 'A',
    });
    if (!img.ok) throw img.error;
    const cx = Math.round(img.value.width / 2);
    const cy = Math.round(img.value.height / 2);
    const centre = (cy * img.value.width + cx) * 4;
    expect(isWhite(img.value.rgba, centre)).toBe(true);
  });

  it('reports text below minTextPx without rescaling it', () => {
    const r = drawingRaster(resolved(), { ...sheetOptions, views: ['front', 'A'], width: 1200 });
    if (!r.ok) throw r.error;
    const small = r.value.report.smallText;
    expect(small.length).toBeGreaterThan(0);
    expect(small.every((t) => t.px < 9)).toBe(true);
    expect(small.map((t) => t.text)).toContain('0');
  });

  it('reports nothing when every text is at least minTextPx', () => {
    const r = drawingRaster(resolved(), {
      ...sheetOptions,
      views: ['front', 'A'],
      width: 1200,
      minTextPx: 2,
    });
    if (!r.ok) throw r.error;
    expect(r.value.report.smallText).toEqual([]);
  });

  it('rejects a negative or non-finite minTextPx', () => {
    const r = drawingRaster(resolved(), { ...sheetOptions, views: ['front', 'A'], minTextPx: -1 });
    expect(r.ok).toBe(false);
  });
});
