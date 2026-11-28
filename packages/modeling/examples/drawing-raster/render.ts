// Renders a mounting plate drawing sheet to PNG: a front view with dimensions, a hole note and a
// table, a section, and a 2x detail of the hole. The whole sheet is written at 2400 px wide and the
// detail view on its own, both from the same SVG layout that drawingSvg emits.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Drawing,
  type DrawingItem,
  drawingPng,
  parseTrueTypeFont,
  resolveDrawing,
  type SheetOptions,
} from '@forgeax/engine-modeling';

const FONT = new URL('../../src/__tests__/fixtures/NotoSansSC-Bold-subset.ttf', import.meta.url);

/** A 200 mm x 120 mm plate with one 30 mm hole, in meters. */
const WIDTH = 0.2;
const HEIGHT = 0.12;
const HOLE = { x: 0.14, y: 0.06, r: 0.015 };

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const items: DrawingItem[] = [
  {
    id: 'plate',
    view: 'front',
    role: 'silhouette',
    kind: 'curve',
    curve: { kind: 'polyline', points: rect(0, 0, WIDTH, HEIGHT) },
    closed: true,
  },
  {
    id: 'hole',
    view: 'front',
    role: 'visible',
    kind: 'curve',
    curve: { kind: 'arc', center: [HOLE.x, HOLE.y], radius: HOLE.r, from: 0, to: 2 * Math.PI },
    closed: true,
    // The hole is hatched and fitted from these points; 0.05 mm keeps them on the circle.
    tolerance: 0.00005,
  },
  { id: 'p0', view: 'front', role: 'pivot', kind: 'point', at: [0, 0] },
  { id: 'p1', view: 'front', role: 'pivot', kind: 'point', at: [WIDTH, 0] },
  { id: 'p2', view: 'front', role: 'pivot', kind: 'point', at: [WIDTH, HEIGHT] },
  {
    id: 'dim-width',
    view: 'front',
    role: 'construction',
    kind: 'dimension',
    measure: 'dx',
    refs: ['p0', 'p1'],
    value: WIDTH,
  },
  {
    id: 'dim-height',
    view: 'front',
    role: 'construction',
    kind: 'dimension',
    measure: 'dy',
    refs: ['p1', 'p2'],
    value: HEIGHT,
  },
  {
    id: 'note-hole',
    view: 'front',
    role: 'break',
    kind: 'note',
    refs: ['hole'],
    text: '\u5b54 R15 (hole R15)',
    at: [0.05, 0.1],
  },
  {
    id: 'table-holes',
    view: 'front',
    role: 'feature',
    kind: 'table',
    columns: ['id', 'x mm', 'y mm'],
    rows: [
      ['p0', 0, 0],
      ['p1', 200, 0],
      ['p2', 200, 120],
    ],
  },
  {
    id: 'cut-plate',
    view: 'cut',
    role: 'section',
    kind: 'curve',
    curve: { kind: 'polyline', points: rect(0, 0, WIDTH, HEIGHT) },
    closed: true,
  },
  {
    id: 'cut-hole',
    view: 'cut',
    role: 'section',
    kind: 'curve',
    curve: { kind: 'arc', center: [HOLE.x, HOLE.y], radius: HOLE.r, from: 0, to: 2 * Math.PI },
    closed: true,
    tolerance: 0.00005,
  },
];

const drawing: Drawing = {
  name: 'mounting plate',
  views: [
    { id: 'front', ortho: 'front' },
    { id: 'cut', section: { axis: 'z', at: 0 } },
    // 2x detail of the hole: 1000 mm per meter over the sheet's 500 mm per meter.
    { id: 'A', of: 'front', detail: { box: [0.11, 0.03, 0.17, 0.09], scale: 1000 } },
  ],
  items,
};

const options: SheetOptions = {
  views: ['front', 'cut', 'A'],
  columns: 3,
  scale: 500,
  sheet: {
    size: 'A3',
    title: { number: 'DWG-RASTER-01', revision: 'A', author: 'ForgeaX', date: '2026-11-11' },
  },
  grid: 0.02,
};

const outDir = process.argv[2] ?? '.forgeax-debug/drawing-raster';
mkdirSync(outDir, { recursive: true });

const resolved = resolveDrawing(drawing);
if (!resolved.ok) throw resolved.error;
// The hole note carries CJK (U+5B54): pass a font that covers it as the third argument. The default
// subset covers ASCII and the symbols only, so the note then fails with its code point named.
const font = parseTrueTypeFont(new Uint8Array(readFileSync(process.argv[3] ?? FONT)));
if (!font.ok) throw font.error;

const sheet = drawingPng(resolved.value, { ...options, width: 2400, font: font.value });
if (!sheet.ok) throw sheet.error;
writeFileSync(join(outDir, 'sheet-2400-v2.png'), sheet.value);

const detail = drawingPng(resolved.value, { ...options, width: 1600, view: 'A', font: font.value });
if (!detail.ok) throw detail.error;
writeFileSync(join(outDir, 'detail-A-1600-v2.png'), detail.value);

console.log(`wrote ${join(outDir, 'sheet-2400-v2.png')} (${sheet.value.length} bytes)`);
console.log(`wrote ${join(outDir, 'detail-A-1600-v2.png')} (${detail.value.length} bytes)`);
