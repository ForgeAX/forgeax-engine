import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from './arrays';
import { hypot2 } from './dmath';
import {
  type BaseView,
  clipSegment,
  type DrawingItem,
  type DrawingRole,
  type DrawingView,
  type DrawnNote,
  type DrawnPoint,
  type DrawnTable,
  drawingViewFrame,
  type ResolvedDrawing,
  type Segment2,
} from './drawing';
import { type ModelingError, modelingError } from './errors';
import type { Point2 } from './primitives';
import { ORTHO_VIEWS, type OrthoView } from './views';

/**
 * Sheet exports of a resolved drawing: SVG (sheet millimeters, one group per view and role,
 * item ids as `data-id`) and DXF R12 (AC1009: a layer per role, polylines, points, text;
 * dimensions as lines and text so every reader opens it; notes as text under their view, with a
 * leader from their first ref). Line types follow ISO 128 by role. With `sheet`, both writers draw
 * the same ISO 5457 sheet furniture (border, zone marks, title block, scale bar) from one primitive
 * list; the output depends only on the drawing and the options (dates and revisions are caller text).
 */

/** ISO 128-style stroke per role: width (sheet millimeters), dash pattern, colour, DXF linetype and colour index. */
const ROLE_STROKE: Readonly<
  Record<
    DrawingRole,
    {
      readonly width: number;
      readonly dash?: string;
      readonly color: string;
      readonly linetype: 'CONTINUOUS' | 'DASHED' | 'DASHDOT';
      readonly aci: number;
    }
  >
> = {
  silhouette: { width: 0.5, color: '#000000', linetype: 'CONTINUOUS', aci: 7 },
  visible: { width: 0.5, color: '#000000', linetype: 'CONTINUOUS', aci: 7 },
  hidden: { width: 0.25, dash: '2 1', color: '#000000', linetype: 'DASHED', aci: 7 },
  material: { width: 0.25, color: '#16a085', linetype: 'CONTINUOUS', aci: 4 },
  feature: { width: 0.35, color: '#c0392b', linetype: 'CONTINUOUS', aci: 1 },
  section: { width: 0.35, color: '#000000', linetype: 'CONTINUOUS', aci: 7 },
  break: { width: 0.35, dash: '3 1.5', color: '#2980b9', linetype: 'DASHED', aci: 5 },
  package: { width: 0.25, color: '#27ae60', linetype: 'CONTINUOUS', aci: 3 },
  pivot: { width: 0.35, color: '#8e44ad', linetype: 'CONTINUOUS', aci: 6 },
  linkage: { width: 0.5, color: '#8e44ad', linetype: 'CONTINUOUS', aci: 6 },
  structure: { width: 0.35, color: '#d35400', linetype: 'CONTINUOUS', aci: 30 },
  guide: { width: 0.18, dash: '6 1.5 1 1.5', color: '#7f8c8d', linetype: 'DASHDOT', aci: 8 },
  construction: { width: 0.18, dash: '2 1', color: '#95a5a6', linetype: 'DASHED', aci: 9 },
};

export type SheetSize = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';

/** ISO 5457 trimmed sheets, landscape [width, height] millimeters. */
const SHEET_MM: Readonly<Record<SheetSize, readonly [number, number]>> = {
  A0: [1189, 841],
  A1: [841, 594],
  A2: [594, 420],
  A3: [420, 297],
  A4: [297, 210],
};

/** ISO 5455 enlargement-free scales as sheet millimeters per meter (1:1 to 1:200). */
const ISO_SCALES: readonly number[] = [1000, 500, 200, 100, 50, 20, 10, 5];

/** Scale-bar lengths in meters (1-2-5 series), longest first. */
const BAR_METERS: readonly number[] = [
  1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001,
];

const FRAME_LEFT = 20;
const FRAME_OTHER = 10;
const TITLE_W = 180;
const TITLE_H = 40;
const BAR_MAX_MM = 100;
const GRID_LINE_LIMIT = 2000;
const NOTE_MM = 2.5;

export interface SheetTitle {
  readonly number?: string;
  readonly revision?: string;
  readonly author?: string;
  readonly date?: string;
}

export interface SheetSpec {
  readonly size: SheetSize;
  /** Default landscape. */
  readonly orientation?: 'landscape' | 'portrait';
  readonly title?: SheetTitle;
}

export interface SheetOptions {
  /** Views to place, in order, left to right in rows of `columns` (default all, 3). */
  readonly views?: readonly string[];
  readonly columns?: number;
  /**
   * Sheet millimeters per meter (default 100, i.e. 1:10). With `sheet` and no `scale` the
   * largest ISO 5455 scale that fits the sheet is chosen.
   */
  readonly scale?: number;
  /** SVG: measured overlays per view id (thin grey polylines), e.g. the model's sections. */
  readonly measured?: Readonly<Record<string, readonly (readonly Point2[])[]>>;
  /** An ISO 5457 sheet: border, zone marks, title block and scale bar around the views. */
  readonly sheet?: SheetSpec;
  /** Grid spacing in meters: thin lines at its multiples in every view cell, labelled in millimeters. */
  readonly grid?: number;
  /**
   * Place views by their direction instead of in rows of `columns`: the front view in the
   * middle, the others around it as the projection method puts them (first angle: top below,
   * right to its left; third angle: top above, right to its right). Views that are not an
   * orthographic direction follow in rows below.
   */
  readonly projection?: 'first' | 'third';
  /** Give each role group an id `layer:<view>:<role>` and a `data-layer` attribute, so a reader can toggle layers. */
  readonly layers?: boolean;
}

interface Cell {
  readonly view: DrawingView;
  /** The view whose items it shows: itself, or a detail's parent. */
  readonly base: string;
  /** [minU, minV, maxU, maxV] in meters. */
  readonly box: readonly [number, number, number, number];
  /** Magnification of a detail over the sheet scale (1 for other views). */
  readonly k: number;
  /** Offset of the cell's box corner (minU, maxV) on the sheet, meters. */
  readonly at: Point2;
  /** The view's note items as text lines (first line prefixed by the item id), listed under the box. */
  readonly notes: readonly {
    readonly note: DrawnNote;
    readonly text: string;
    readonly first: boolean;
  }[];
  /** The view's tables under its notes: column widths (meters) and the top, in lines under the box. */
  readonly tables: readonly {
    readonly table: DrawnTable;
    readonly widths: readonly number[];
    readonly top: number;
  }[];
}

interface Plan {
  readonly cells: readonly Cell[];
  /** Layout size, meters. */
  readonly size: Point2;
  readonly line: number;
  /** Sheet millimeters per meter. */
  readonly scale: number;
  readonly sheet?: SheetFrame;
}

type Prim =
  | {
      readonly t: 'line';
      readonly g: SheetGroup;
      readonly a: Point2;
      readonly b: Point2;
      readonly w: number;
      readonly attr?: string;
    }
  | {
      readonly t: 'text';
      readonly g: SheetGroup;
      readonly at: Point2;
      readonly size: number;
      readonly text: string;
      readonly middle?: boolean;
      readonly attr?: string;
    };

type SheetGroup = 'border' | 'zones' | 'title' | 'scale-bar';

interface SheetFrame {
  readonly w: number;
  readonly h: number;
  /** Millimeter offset of the layout's origin on the sheet. */
  readonly ox: number;
  readonly oy: number;
  readonly prims: readonly Prim[];
}

function invalid(expected: string, detail: Record<string, unknown>): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

function checkOptions(options: SheetOptions): ModelingError | undefined {
  if (options.scale !== undefined && !(options.scale > 0 && Number.isFinite(options.scale)))
    return invalid('scale is positive sheet millimeters per meter', { scale: options.scale });
  if (options.grid !== undefined && !(options.grid > 0 && Number.isFinite(options.grid)))
    return invalid('grid is a positive spacing in meters', { grid: options.grid });
  if (
    options.projection !== undefined &&
    options.projection !== 'first' &&
    options.projection !== 'third'
  )
    return invalid("projection is 'first' or 'third'", { projection: options.projection });
  const sheet = options.sheet;
  if (sheet === undefined) return undefined;
  if (!Object.hasOwn(SHEET_MM, sheet.size))
    return invalid(`sheet.size is one of ${Object.keys(SHEET_MM).join(', ')}`, {
      size: sheet.size,
    });
  if (
    sheet.orientation !== undefined &&
    sheet.orientation !== 'landscape' &&
    sheet.orientation !== 'portrait'
  )
    return invalid("sheet.orientation is 'landscape' or 'portrait'", {
      orientation: sheet.orientation,
    });
  for (const key of ['number', 'revision', 'author', 'date'] as const) {
    const value: unknown = sheet.title?.[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > 200))
      return invalid(`sheet.title.${key} is a string of at most 200 characters`, { field: key });
  }
  return undefined;
}

function baseIds(d: ResolvedDrawing): Map<string, string> {
  return new Map(d.views.map((v) => [v.id, 'detail' in v ? v.of : v.id]));
}

function noteLines(
  d: ResolvedDrawing,
  base: string,
  bases: ReadonlyMap<string, string>,
): Cell['notes'] {
  return d.items.flatMap((i) =>
    i.kind === 'note' && i.at === undefined && bases.get(i.view) === base
      ? `${i.id}: ${i.text}`.split(/\r?\n/).map((text, n) => ({ note: i, text, first: n === 0 }))
      : [],
  );
}

const BALLOON_MM = 3.5;

function deviationText(meters: number): string {
  const mm = Math.round(meters * 10000) / 10;
  return `${mm > 0 ? '+' : ''}${trimNumber(mm)} mm`;
}

/** The point on a balloon circle (radius `BALLOON_MM`) facing `from`, or undefined when they coincide. */
function balloonEdge(from: Point2, center: Point2): Point2 | undefined {
  const dx = from[0] - center[0];
  const dy = from[1] - center[1];
  const l = hypot2(dx, dy);
  return l > BALLOON_MM
    ? [center[0] + (dx / l) * BALLOON_MM, center[1] + (dy / l) * BALLOON_MM]
    : undefined;
}

/** Ruled cells of a table in view meters under its box (header first), each with its text. */
function tableCells(
  c: Cell,
  t: Cell['tables'][number],
  line: number,
): { u0: number; v0: number; u1: number; v1: number; text: string; head: boolean }[] {
  const rows = [t.table.columns as readonly (string | number)[], ...t.table.rows];
  return rows.flatMap((row, r) => {
    let u = c.box[0];
    const v0 = c.box[1] - (t.top + r) * line;
    return t.widths.map((w, k) => {
      const cell = { u0: u, v0, u1: u + w, v1: v0 - line, text: tableCell(row[k]), head: r === 0 };
      u += w;
      return cell;
    });
  });
}
const TABLE_CHAR_WIDTH = 0.6;

function tableWidths(t: DrawnTable, textSize: number): number[] {
  return t.columns.map((head, c) => {
    const longest = Math.max(head.length, ...t.rows.map((r) => String(r[c] ?? '').length));
    return (longest * TABLE_CHAR_WIDTH + 0.8) * textSize;
  });
}

function tableCell(value: string | number | undefined): string {
  return String(value ?? '');
}

/** Sheet point a note's leader starts from: its first ref (a point, a dimension's span start, a curve's first sample). */
function noteAnchor(d: ResolvedDrawing, note: DrawnNote): Point2 | undefined {
  const id = note.refs[0];
  const item: DrawingItem | undefined = d.items.find((i) => i.id === id);
  if (item === undefined || item.view !== note.view) return undefined;
  if (item.kind === 'point') return item.at;
  if (item.kind === 'dimension') return d.dimensions.find((x) => x.id === id)?.from;
  return d.curves.find((c) => c.id === id)?.points[0];
}

const PROJECTED: Readonly<
  Record<'first' | 'third', Readonly<Record<OrthoView, readonly [number, number]>>>
> = {
  third: { front: [1, 1], top: [1, 0], bottom: [1, 2], right: [2, 1], left: [0, 1], back: [3, 1] },
  first: { front: [1, 1], top: [1, 2], bottom: [1, 0], right: [0, 1], left: [2, 1], back: [3, 1] },
};

function orthoOf(view: DrawingView): OrthoView | undefined {
  if ('detail' in view || 'explode' in view) return undefined;
  const t = drawingViewFrame(view as BaseView).frame.toward;
  for (const name of Object.keys(ORTHO_VIEWS) as OrthoView[]) {
    const o = ORTHO_VIEWS[name].toward;
    if (o[0] === t[0] && o[1] === t[1] && o[2] === t[2]) return name;
  }
  return undefined;
}

/** [column, row] of each view: rows of `columns`, or the projection method's cross with the rest below it. */
function viewSlots(
  views: readonly DrawingView[],
  columns: number,
  projection: 'first' | 'third' | undefined,
): (readonly [number, number])[] {
  if (projection === undefined) return views.map((_, n) => [n % columns, Math.floor(n / columns)]);
  const taken = new Set<string>();
  const placed = views.map((v) => {
    const name = orthoOf(v);
    const slot = name === undefined ? undefined : PROJECTED[projection][name];
    if (slot === undefined || taken.has(slot.join())) return undefined;
    taken.add(slot.join());
    return slot;
  });
  const top = placed.reduce((a, s) => Math.max(a, s === undefined ? -1 : s[1]), -1);
  const minCol = placed.reduce((a, s) => Math.min(a, s === undefined ? a : s[0]), 99);
  let extra = 0;
  return placed.map((s) => {
    if (s !== undefined) return [s[0] - (minCol === 99 ? 0 : minCol), s[1]] as const;
    const n = extra++;
    return [n % columns, top + 1 + Math.floor(n / columns)] as const;
  });
}

/**
 * Layout of the sheet in drawing meters at `scale`: each view's box, padded, in rows of `columns`,
 * with room under the box for the view's notes (`line` meters per text line). A detail is its
 * parent's window enlarged by its own scale over `scale`.
 */
function layout(
  d: ResolvedDrawing,
  options: SheetOptions,
  scale: number,
): { cells: Cell[]; size: Point2; line: number } {
  const columns = Math.max(1, options.columns ?? 3);
  const ids = options.views ?? d.views.map((v) => v.id);
  const views = ids.flatMap((id) => d.views.filter((v) => v.id === id));
  const bases = baseIds(d);
  const boxes = views.map((view) => {
    if ('detail' in view) return { box: view.detail.box, k: view.detail.scale / scale };
    const own = (id: string) => bases.get(id) === view.id;
    const pts: Point2[] = [
      ...d.curves.filter((c) => own(c.view)).flatMap((c) => c.points),
      ...d.items.flatMap((i) => (i.kind === 'point' && own(i.view) ? [i.at] : [])),
      ...d.items.flatMap((i) =>
        i.kind === 'note' && i.at !== undefined && own(i.view) ? [i.at] : [],
      ),
      ...views.flatMap((v) =>
        'detail' in v && v.of === view.id
          ? [
              [v.detail.box[0], v.detail.box[1]] as Point2,
              [v.detail.box[2], v.detail.box[3]] as Point2,
            ]
          : [],
      ),
      ...(options.measured?.[view.id] ?? []).flat(),
    ];
    if (pts.length === 0) return { box: [0, 0, 0.1, 0.1] as const, k: 1 };
    const us = pts.map((p) => p[0]);
    const vs = pts.map((p) => p[1]);
    return {
      box: [minOf(us), minOf(vs), maxOf(us), maxOf(vs)] as const,
      k: 1,
    };
  });
  const wide = (b: (typeof boxes)[number]) => (b.box[2] - b.box[0]) * b.k;
  const tall = (b: (typeof boxes)[number]) => (b.box[3] - b.box[1]) * b.k;
  const span = Math.max(0.1, ...boxes.map((b) => Math.max(wide(b), tall(b))));
  const pad = options.sheet === undefined ? 0.12 * span : 8 / scale;
  const line = options.sheet === undefined ? 0.03 * span : Math.max(0.03 * span, 3.2 / scale);
  const notes = views.map((view) => ('detail' in view ? [] : noteLines(d, view.id, bases)));
  const textSize = options.sheet === undefined ? 0.8 * line : NOTE_MM / scale;
  const tables = views.map((view, n) => {
    if ('detail' in view) return [];
    let top = (notes[n]?.length ?? 0) + 0.5;
    return d.items.flatMap((i) => {
      if (i.kind !== 'table' || bases.get(i.view) !== view.id) return [];
      const placed = { table: i, widths: tableWidths(i, textSize), top };
      top += i.rows.length + 2;
      return [placed];
    });
  });
  const tableLines = tables.map((ts) =>
    ts.length === 0
      ? 0
      : (ts.at(-1) as (typeof ts)[number]).top +
        (ts.at(-1) as (typeof ts)[number]).table.rows.length +
        1,
  );
  const tableWide = tables.map((ts) =>
    Math.max(0, ...ts.map((t) => t.widths.reduce((a, b) => a + b, 0))),
  );
  const slots = viewSlots(views, columns, options.projection);
  const rows = slots.reduce((a, [, r]) => Math.max(a, r + 1), 0);
  const cols = slots.reduce((a, [c]) => Math.max(a, c + 1), 0);
  const inSlot = (c: number, r: number) =>
    boxes.flatMap((b, n) => {
      const slot = slots[n] as readonly [number, number];
      return slot[0] === c || slot[1] === r ? [{ b, n, slot }] : [];
    });
  const width = (b: (typeof boxes)[number], n: number) =>
    Math.max(wide(b), tableWide[n] ?? 0) + 2 * pad;
  const height = (b: (typeof boxes)[number], n: number) =>
    tall(b) + 2 * pad + Math.max(notes[n]?.length ?? 0, tableLines[n] ?? 0) * line;
  const colW = Array.from({ length: cols }, (_, c) =>
    Math.max(0, ...inSlot(c, -1).flatMap(({ b, n, slot }) => (slot[0] === c ? [width(b, n)] : []))),
  );
  const rowH = Array.from({ length: rows }, (_, r) =>
    Math.max(
      0,
      ...inSlot(-1, r).flatMap(({ b, n, slot }) => (slot[1] === r ? [height(b, n)] : [])),
    ),
  );
  const cells = views.map((view, n): Cell => {
    const [col, row] = slots[n] as readonly [number, number];
    const x = colW.slice(0, col).reduce((a, b) => a + b, 0) + pad;
    const y = rowH.slice(0, row).reduce((a, b) => a + b, 0) + pad;
    const b = boxes[n] as (typeof boxes)[number];
    return {
      view,
      base: bases.get(view.id) as string,
      box: b.box,
      k: b.k,
      at: [x, y],
      notes: notes[n] ?? [],
      tables: tables[n] ?? [],
    };
  });
  return {
    cells,
    size: [colW.reduce((a, b) => a + b, 0), rowH.reduce((a, b) => a + b, 0)],
    line,
  };
}

function trimNumber(x: number): string {
  return String(Number(x.toFixed(2)));
}

/** A scale as the ratio label of a drawing: 500 mm per meter is `1:2`. */
function ratioLabel(mmPerMeter: number): string {
  return mmPerMeter >= 1000
    ? `${trimNumber(mmPerMeter / 1000)}:1`
    : `1:${trimNumber(1000 / mmPerMeter)}`;
}

function fit(text: string, width: number, size: number): string {
  const max = Math.max(1, Math.floor(width / (0.6 * size)));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 3))}...`;
}

/** Border, zone marks, title block and scale bar of an ISO 5457 sheet, in sheet millimeters (y down). */
function furniture(
  d: ResolvedDrawing,
  spec: SheetSpec,
  scale: number,
  w: number,
  h: number,
): Prim[] {
  const x0 = FRAME_LEFT;
  const y0 = FRAME_OTHER;
  const x1 = w - FRAME_OTHER;
  const y1 = h - FRAME_OTHER;
  const prims: Prim[] = [];
  const line = (g: SheetGroup, a: Point2, b: Point2, width: number, attr?: string) =>
    prims.push({ t: 'line', g, a, b, w: width, ...(attr === undefined ? {} : { attr }) });
  const text = (
    g: SheetGroup,
    at: Point2,
    size: number,
    value: string,
    extra: { middle?: boolean; attr?: string } = {},
  ) => {
    if (value.length > 0) prims.push({ t: 'text', g, at, size, text: value, ...extra });
  };
  const rect = (
    g: SheetGroup,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    width: number,
    attr?: string,
  ) => {
    line(g, [ax, ay], [bx, ay], width, attr);
    line(g, [bx, ay], [bx, by], width, attr);
    line(g, [bx, by], [ax, by], width, attr);
    line(g, [ax, by], [ax, ay], width, attr);
  };
  rect('border', x0, y0, x1, y1, 0.7, 'data-border=""');
  const columns = 2 * Math.round(w / 100);
  const rows = 2 * Math.round(h / 100);
  const cw = (x1 - x0) / columns;
  const rh = (y1 - y0) / rows;
  for (let i = 0; i <= columns; i++) line('zones', [x0 + i * cw, y0 - 5], [x0 + i * cw, y0], 0.35);
  for (let r = 0; r <= rows; r++) line('zones', [x0 - 5, y0 + r * rh], [x0, y0 + r * rh], 0.35);
  for (let i = 0; i < columns; i++)
    text('zones', [x0 + (i + 0.5) * cw, y0 - 1.5], 3, String(i + 1), {
      middle: true,
      attr: `data-zone="${i + 1}"`,
    });
  for (let r = 0; r < rows; r++) {
    const letter = String.fromCharCode(65 + r);
    text('zones', [x0 - 2.5, y0 + (r + 0.5) * rh + 1], 3, letter, {
      middle: true,
      attr: `data-zone="${letter}"`,
    });
  }
  const bx = x1 - TITLE_W;
  const by = y1 - TITLE_H;
  rect('title', bx, by, x1, y1, 0.7);
  for (const y of [by + 10, by + 18, by + 26]) line('title', [bx, y], [x1, y], 0.35);
  for (const x of [bx + 100, bx + 150]) line('title', [x, by + 10], [x, by + 26], 0.35);
  line('title', [bx + 60, by + 26], [bx + 60, y1], 0.35);
  text('title', [bx + 3, by + 7], 5, fit(d.name, TITLE_W - 6, 5));
  const field = (caption: string, value: string, x: number, y: number, width: number) => {
    text('title', [x + 2, y], 1.6, caption);
    text('title', [x + 2, y + 4.2], 3, fit(value, width - 4, 3));
  };
  const t = spec.title ?? {};
  field('Source', d.sources[0]?.title ?? '', bx, by + 13, 100);
  field('No.', t.number ?? '', bx + 100, by + 13, 50);
  field('Rev.', t.revision ?? '', bx + 150, by + 13, 30);
  field('Author', t.author ?? '', bx, by + 21, 100);
  field('Issued', t.date ?? '', bx + 100, by + 21, 50);
  field('Size', spec.size, bx + 150, by + 21, 30);
  text('title', [bx + 2, by + 30], 1.6, 'Scale');
  text('title', [bx + 2, by + 37], 5, ratioLabel(scale));
  const metres = BAR_METERS.find((m) => m * scale <= BAR_MAX_MM + 1e-9) as number;
  const length = metres * scale;
  const barX = bx + 70;
  const barY = y1 - 6;
  const barText = (m: number) => (m >= 1 ? `${trimNumber(m)} m` : `${trimNumber(m * 1000)} mm`);
  line(
    'scale-bar',
    [barX, barY],
    [barX + length, barY],
    0.5,
    `data-bar-m="${Number(metres.toPrecision(6))}"`,
  );
  for (const f of [0, 0.5, 1])
    line('scale-bar', [barX + f * length, barY - 2], [barX + f * length, barY], 0.35);
  text('scale-bar', [barX, y1 - 2], 2.5, '0', { middle: true });
  text('scale-bar', [barX + length, y1 - 2], 2.5, barText(metres), { middle: true });
  return prims;
}

/** The plan of a sheet: the chosen scale, the layout at it and, with `sheet`, the furniture and where the layout sits. */
function plan(d: ResolvedDrawing, options: SheetOptions): Result<Plan, ModelingError> {
  const bad = checkOptions(options);
  if (bad !== undefined) return err(bad);
  const spec = options.sheet;
  if (spec === undefined) {
    const scale = options.scale ?? 100;
    return ok({ ...layout(d, options, scale), scale });
  }
  const [lw, lh] = SHEET_MM[spec.size];
  const [w, h] = spec.orientation === 'portrait' ? [lh, lw] : [lw, lh];
  const available: Point2 = [w - FRAME_LEFT - FRAME_OTHER, h - 2 * FRAME_OTHER - TITLE_H];
  const attempt = (scale: number) => {
    const l = layout(d, options, scale);
    const needed: Point2 = [l.size[0] * scale, l.size[1] * scale];
    return { l, scale, needed, fits: needed[0] <= available[0] && needed[1] <= available[1] };
  };
  const choice =
    options.scale !== undefined
      ? attempt(options.scale)
      : (ISO_SCALES.map(attempt).find((a) => a.fits) ??
        attempt(ISO_SCALES[ISO_SCALES.length - 1] as number));
  if (!choice.fits) {
    return err(
      modelingError(
        'model-precondition',
        `the views fit the ${spec.size} sheet at 1:${trimNumber(1000 / choice.scale)}`,
        { needed: choice.needed, available },
        'use a larger sheet, fewer views or a smaller scale',
      ),
    );
  }
  return ok({
    cells: choice.l.cells,
    size: choice.l.size,
    line: choice.l.line,
    scale: choice.scale,
    sheet: {
      w,
      h,
      ox: FRAME_LEFT + (available[0] - choice.needed[0]) / 2,
      oy: FRAME_OTHER + (available[1] - choice.needed[1]) / 2,
      prims: furniture(d, spec, choice.scale, w, h),
    },
  });
}

function titleText(c: Cell): string {
  if ('detail' in c.view)
    return `${c.view.detail.label ?? c.view.id} (detail of ${c.view.of} ${ratioLabel(c.view.detail.scale)})`;
  if ('explode' in c.view)
    return `${c.view.id} (exploded view of ${c.view.of} by ${c.view.explode.by}; no hidden-line removal)`;
  const view = c.view;
  const kind =
    'ortho' in view
      ? view.ortho
      : 'toward' in view
        ? `toward ${view.toward.map((x) => trimNumber(x)).join(',')}`
        : `section ${view.section.axis} = ${view.section.at}`;
  return `${view.id} (${kind})`;
}

/** A dimension's label: its id and value, angles in degrees (data stays in radians), lengths in meters. */
function dimensionLabel(dim: ResolvedDrawing['dimensions'][number]): string {
  return dim.measure === 'angle'
    ? `${dim.id} ${((dim.value * 180) / Math.PI).toFixed(1)} deg`
    : `${dim.id} ${dim.value.toFixed(3)} m`;
}

/** A point's label in a view cell: its id without a trailing `@<that view's id>`. */
function pointLabel(id: string, view: string): string {
  return id.endsWith(`@${view}`) && id.length > view.length + 1
    ? id.slice(0, -(view.length + 1))
    : id;
}

type Box4 = readonly [number, number, number, number];

const inBox = (p: Point2, b: Box4) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/** Pieces of `points` inside `box`, as open runs. */
function clipRuns(points: readonly Point2[], closed: boolean, box: Box4): Point2[][] {
  const runs: Point2[][] = [];
  let current: Point2[] | undefined;
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const a = points[i] as Point2;
    const b = points[(i + 1) % points.length] as Point2;
    const seg = clipSegment(a, b, box);
    if (seg === undefined) {
      current = undefined;
      continue;
    }
    const last = current?.[current.length - 1];
    if (
      current !== undefined &&
      last !== undefined &&
      last[0] === seg[0][0] &&
      last[1] === seg[0][1]
    )
      current.push(seg[1]);
    else {
      current = [seg[0], seg[1]];
      runs.push(current);
    }
    if (seg[1] !== b) current = undefined;
  }
  return runs;
}

interface CellContent {
  readonly curves: readonly {
    readonly id: string;
    readonly role: DrawingRole;
    readonly closed: boolean;
    readonly points: readonly Point2[];
  }[];
  readonly hatches: readonly Segment2[];
  readonly points: readonly DrawnPoint[];
  readonly dimensions: readonly (ResolvedDrawing['dimensions'][number] & {
    readonly from: Point2;
    readonly to: Point2;
  })[];
  readonly measured: readonly (readonly Point2[])[];
  readonly placed: readonly DrawnNote[];
  readonly marks: readonly { readonly id: string; readonly label: string; readonly box: Box4 }[];
  readonly grid: { readonly u: readonly number[]; readonly v: readonly number[] } | undefined;
}

/** What a cell shows, in its view's coordinates: a detail's content is its parent's clipped to the box. */
function cellContent(
  d: ResolvedDrawing,
  options: SheetOptions,
  c: Cell,
  cells: readonly Cell[],
): Result<CellContent, ModelingError> {
  const bases = baseIds(d);
  const own = (view: string) => bases.get(view) === c.base;
  const clip = 'detail' in c.view ? c.view.detail.box : undefined;
  const curves = d.curves
    .filter((k) => own(k.view))
    .flatMap((k) =>
      clip === undefined
        ? [{ id: k.id, role: k.role, closed: k.closed, points: k.points }]
        : clipRuns(k.points, k.closed, clip).map((points) => ({
            id: k.id,
            role: k.role,
            closed: false,
            points,
          })),
    );
  const hatches = (d.hatches.find((h) => h.view === c.base)?.segments ?? []).flatMap((s) => {
    if (clip === undefined) return [s];
    const seg = clipSegment(s[0], s[1], clip);
    return seg === undefined ? [] : [seg];
  });
  const points = d.items.flatMap((i): DrawnPoint[] =>
    i.kind === 'point' && own(i.view) && (clip === undefined || inBox(i.at, clip)) ? [i] : [],
  );
  const dimensions = d.dimensions.flatMap((dim) =>
    own(dim.view) &&
    dim.from !== undefined &&
    dim.to !== undefined &&
    (clip === undefined || (inBox(dim.from, clip) && inBox(dim.to, clip)))
      ? [{ ...dim, from: dim.from, to: dim.to }]
      : [],
  );
  const measured = (options.measured?.[c.base] ?? []).flatMap((m) =>
    clip === undefined ? [m] : clipRuns(m, false, clip),
  );
  const placed = d.items.flatMap((i): DrawnNote[] =>
    i.kind === 'note' &&
    i.at !== undefined &&
    own(i.view) &&
    (clip === undefined || inBox(i.at, clip))
      ? [i]
      : [],
  );
  const marks = cells.flatMap((o) =>
    'detail' in o.view && o.view.of === c.view.id && clip === undefined
      ? [{ id: o.view.id, label: o.view.detail.label ?? o.view.id, box: o.view.detail.box }]
      : [],
  );
  let grid: CellContent['grid'];
  if (options.grid !== undefined) {
    const step = options.grid;
    const box = clip ?? c.box;
    const axis = (lo: number, hi: number) => {
      const first = Math.ceil(lo / step - 1e-9);
      const last = Math.floor(hi / step + 1e-9);
      return { first, last };
    };
    const [u, v] = [axis(box[0], box[2]), axis(box[1], box[3])];
    if (u.last - u.first + 1 > GRID_LINE_LIMIT || v.last - v.first + 1 > GRID_LINE_LIMIT) {
      return err(
        modelingError(
          'model-work-budget',
          `a grid draws at most ${GRID_LINE_LIMIT} lines per axis and view`,
          { grid: step, lines: Math.max(u.last - u.first + 1, v.last - v.first + 1) },
        ),
      );
    }
    const values = (r: { first: number; last: number }) =>
      Array.from({ length: Math.max(0, r.last - r.first + 1) }, (_, i) => (r.first + i) * step);
    grid = { u: values(u), v: values(v) };
  }
  return ok({ curves, hatches, points, dimensions, measured, placed, marks, grid });
}

interface PlacedLabel {
  /** Left end of the text baseline, in the caller's sheet units and y direction. */
  readonly at: Point2;
  /** True when every corner was taken and the label moved out: draw a leader from the point. */
  readonly leader: boolean;
}

/**
 * Greedy, deterministic label placement for one view cell, in item order: each label takes the
 * first free corner around its point (upper right, upper left, lower right, lower left), free of
 * labels already placed and of every point marker. If all four are taken it moves out along the
 * upper-right diagonal until free (at most 12 steps) and gets a leader; no label is dropped.
 * `size` is the text height and `gap` the offset from the point, in sheet units; `down` says the
 * sheet's y axis points down (SVG) rather than up (DXF).
 */
function placeLabels(
  labels: readonly { readonly at: Point2; readonly text: string }[],
  size: number,
  gap: number,
  down: boolean,
): PlacedLabel[] {
  type Box = readonly [number, number, number, number];
  const ySign = down ? -1 : 1;
  const up = (p: Point2): Point2 => [p[0], ySign * p[1]];
  const marker = size / 3;
  const taken: Box[] = labels.map(({ at }) => {
    const [x, y] = up(at);
    return [x - marker, y - marker, x + marker, y + marker];
  });
  const free = (b: Box) =>
    !taken.some((t) => b[0] < t[2] && t[0] < b[2] && b[1] < t[3] && t[1] < b[3]);
  return labels.map(({ at, text }) => {
    const [x, y] = up(at);
    const w = 0.6 * size * text.length;
    const corner = (sx: number, sy: number, k = 1): Box => {
      const x0 = sx > 0 ? x + k * gap : x - k * gap - w;
      const y0 = sy > 0 ? y + k * gap : y - k * gap - size;
      return [x0, y0, x0 + w, y0 + size];
    };
    const options: Box[] = [corner(1, 1), corner(-1, 1), corner(1, -1), corner(-1, -1)];
    let box = options.find(free);
    let leader = false;
    if (box === undefined) {
      leader = true;
      box = options[0] as Box;
      for (let k = 2; k <= 12; k++) {
        const next = corner(1, 1, k);
        box = next;
        if (free(next)) break;
      }
    }
    taken.push(box);
    return { at: up([box[0], box[1]]), leader };
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Sheet millimeters (y down) of a point in a cell's view coordinates. */
function mapper(c: Cell, scale: number, ox: number, oy: number) {
  return (p: Point2): Point2 => [
    ox + (c.at[0] + (p[0] - c.box[0]) * c.k) * scale,
    oy + (c.at[1] + (c.box[3] - p[1]) * c.k) * scale,
  ];
}

const GRID_COLOR = '#d0d7de';

/** The drawing as an SVG sheet (sizes in millimeters). */
export function drawingSvg(
  d: ResolvedDrawing,
  options: SheetOptions = {},
): Result<string, ModelingError> {
  const planned = plan(d, options);
  if (!planned.ok) return planned;
  const { cells, size, line, scale, sheet } = planned.value;
  const header = sheet === undefined ? 10 : 0;
  const ox = sheet?.ox ?? 0;
  const oy = (sheet?.oy ?? 0) + header;
  const width = sheet?.w ?? size[0] * scale;
  const height = sheet?.h ?? size[1] * scale + header;
  const f = (x: number) => x.toFixed(2);
  const pt = (p: Point2) => `${f(p[0])},${f(p[1])}`;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${trimNumber(width)}mm" height="${trimNumber(height)}mm" viewBox="0 0 ${trimNumber(width)} ${trimNumber(height)}" font-family="sans-serif" font-size="3">`,
    '<rect width="100%" height="100%" fill="white"/>',
  ];
  if (sheet === undefined) out.push(`<text x="4" y="6" font-size="4">${escapeXml(d.name)}</text>`);
  const titleGap = sheet === undefined ? 4 : 2;
  const noteSize = sheet === undefined ? 0.8 * line * scale : NOTE_MM;
  for (const c of cells) {
    const content = cellContent(d, options, c, cells);
    if (!content.ok) return content;
    const k = content.value;
    const X = mapper(c, scale, ox, oy);
    const [tx, ty] = X([c.box[0], c.box[3]]);
    out.push(
      `<g data-view="${escapeXml(c.view.id)}"><text x="${f(tx)}" y="${f(ty - titleGap)}">${escapeXml(titleText(c))}</text>`,
    );
    if (k.grid !== undefined) {
      const box = 'detail' in c.view ? c.view.detail.box : c.box;
      const [lo, hi] = [X([box[0], box[1]]), X([box[2], box[3]])];
      out.push(`<g data-grid-lines="" stroke="${GRID_COLOR}" stroke-width="0.1" fill="none">`);
      for (const u of k.grid.u) {
        const x = f(X([u, box[1]])[0]);
        out.push(
          `<line data-grid="u" x1="${x}" y1="${f(lo[1])}" x2="${x}" y2="${f(hi[1])}"/><text data-grid-label="u" x="${x}" y="${f(lo[1] + 2.4)}" stroke="none" fill="#7f8c8d" font-size="1.6" text-anchor="middle">${Math.round(u * 1000)}</text>`,
        );
      }
      for (const v of k.grid.v) {
        const y = f(X([box[0], v])[1]);
        out.push(
          `<line data-grid="v" x1="${f(lo[0])}" y1="${y}" x2="${f(hi[0])}" y2="${y}"/><text data-grid-label="v" x="${f(lo[0] - 0.8)}" y="${f(Number(y) + 0.6)}" stroke="none" fill="#7f8c8d" font-size="1.6" text-anchor="end">${Math.round(v * 1000)}</text>`,
        );
      }
      out.push('</g>');
    }
    if (k.hatches.length > 0) {
      out.push('<g data-role="hatch" stroke="#7f8c8d" stroke-width="0.18" fill="none">');
      for (const [a, b] of k.hatches) {
        const [p, q] = [X(a), X(b)];
        out.push(`<line x1="${f(p[0])}" y1="${f(p[1])}" x2="${f(q[0])}" y2="${f(q[1])}"/>`);
      }
      out.push('</g>');
    }
    for (const m of k.measured) {
      out.push(
        `<polyline fill="none" stroke="#b0b0b0" stroke-width="0.25" points="${m.map((p) => pt(X(p))).join(' ')}"/>`,
      );
    }
    const placed = new Map(
      placeLabels(
        k.points.map((p) => ({ at: X(p.at), text: pointLabel(p.id, c.view.id) })),
        2.2,
        1.2,
        true,
      ).map((l, n) => [(k.points[n] as DrawnPoint).id, l]),
    );
    const painter = 'explode' in c.view;
    if (painter) {
      for (const x of k.curves) {
        const s = ROLE_STROKE[x.role];
        const fill = x.closed && x.role === 'silhouette' ? 'white' : 'none';
        out.push(
          `<g data-role="${x.role}" stroke="${s.color}" stroke-width="${s.width}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} fill="none"><${x.closed ? 'polygon' : 'polyline'} data-id="${escapeXml(x.id)}" fill="${fill}" points="${x.points.map((p) => pt(X(p))).join(' ')}"/></g>`,
        );
      }
    }
    for (const role of Object.keys(ROLE_STROKE) as DrawingRole[]) {
      const curves = painter ? [] : k.curves.filter((x) => x.role === role);
      const points = k.points.filter((p) => p.role === role);
      if (curves.length === 0 && points.length === 0) continue;
      const s = ROLE_STROKE[role];
      const layer =
        options.layers === true
          ? ` id="layer:${escapeXml(c.view.id)}:${role}" data-layer="${role}"`
          : '';
      out.push(
        `<g${layer} data-role="${role}" stroke="${s.color}" stroke-width="${s.width}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} fill="none">`,
      );
      for (const x of curves) {
        out.push(
          `<${x.closed ? 'polygon' : 'polyline'} data-id="${escapeXml(x.id)}" points="${x.points.map((p) => pt(X(p))).join(' ')}"/>`,
        );
      }
      for (const p of points) {
        const [px, py] = X(p.at);
        const l = placed.get(p.id) as PlacedLabel;
        const leader = l.leader
          ? `<line x1="${f(px)}" y1="${f(py)}" x2="${f(l.at[0])}" y2="${f(l.at[1])}" stroke-width="0.18"/>`
          : '';
        out.push(
          `<circle data-id="${escapeXml(p.id)}" cx="${f(px)}" cy="${f(py)}" r="0.8"/>${leader}<text x="${f(l.at[0])}" y="${f(l.at[1])}" stroke="none" fill="${s.color}" font-size="2.2">${escapeXml(pointLabel(p.id, c.view.id))}</text>`,
        );
      }
      out.push('</g>');
    }
    for (const dim of k.dimensions) {
      const [a, b] = [X(dim.from), X(dim.to)];
      out.push(
        `<g data-id="${escapeXml(dim.id)}" stroke="#27ae60" stroke-width="0.25"><line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}"/><text x="${f((a[0] + b[0]) / 2)}" y="${f((a[1] + b[1]) / 2 - 1)}" stroke="none" fill="#27ae60" font-size="2.2">${escapeXml(dimensionLabel(dim))}</text></g>`,
      );
    }
    for (const mark of k.marks) {
      const [a, b] = [X([mark.box[0], mark.box[3]]), X([mark.box[2], mark.box[1]])];
      out.push(
        `<g data-detail-mark="${escapeXml(mark.id)}" stroke="#000000" stroke-width="0.25" fill="none"><rect x="${f(a[0])}" y="${f(a[1])}" width="${f(b[0] - a[0])}" height="${f(b[1] - a[1])}" stroke-dasharray="1.5 1"/><text x="${f(a[0])}" y="${f(b[1] + 4)}" stroke="none" fill="#000000" font-size="3">${escapeXml(mark.label)}</text></g>`,
      );
    }
    for (const note of k.placed) {
      const s = ROLE_STROKE[note.role];
      const [x, y] = X(note.at as Point2);
      const anchor = noteAnchor(d, note);
      if (note.balloon === true) {
        const edge = anchor === undefined ? undefined : balloonEdge(X(anchor), [x, y]);
        const over =
          note.deviation !== undefined && Math.abs(note.deviation) > (note.tolerance ?? 0.002);
        const tone = over ? ROLE_STROKE.feature.color : s.color;
        const dev = note.deviation === undefined ? '' : deviationText(note.deviation);
        const leader =
          anchor === undefined || edge === undefined
            ? ''
            : `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width}" points="${pt(X(anchor))} ${pt(edge)}"/>`;
        out.push(
          `<g data-role="${note.role}">${leader}<circle data-id="${escapeXml(note.id)}" cx="${f(x)}" cy="${f(y)}" r="${BALLOON_MM}" fill="white" stroke="${tone}" stroke-width="${s.width}"/><text x="${f(x)}" y="${f(y + (dev === '' ? 0.35 : 0.1) * noteSize)}" fill="${tone}" font-size="${f(noteSize)}" text-anchor="middle">${escapeXml(note.text)}</text>${dev === '' ? '' : `<text data-deviation="" x="${f(x)}" y="${f(y + 0.9 * noteSize)}" fill="${tone}" font-size="${f(0.7 * noteSize)}" text-anchor="middle">${dev}</text>`}</g>`,
        );
        continue;
      }
      for (const [n, textLine] of `${note.id}: ${note.text}`.split(/\r?\n/).entries()) {
        const leader =
          n === 0 && anchor !== undefined
            ? `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} points="${pt(X(anchor))} ${pt([x, y])}"/>`
            : '';
        out.push(
          `<g data-id="${escapeXml(note.id)}" data-role="${note.role}">${leader}<text x="${f(x)}" y="${f(y + n * 1.2 * noteSize)}" fill="${s.color}" font-size="${f(noteSize)}">${escapeXml(textLine)}</text></g>`,
        );
      }
    }
    for (const [n, { note, text, first }] of c.notes.entries()) {
      const s = ROLE_STROKE[note.role];
      const at = X([c.box[0], c.box[1] - (n + 1) * line]);
      const anchor = first ? noteAnchor(d, note) : undefined;
      const leader =
        anchor === undefined
          ? ''
          : `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} points="${pt(X(anchor))} ${pt(at)}"/>`;
      out.push(
        `<g data-id="${escapeXml(note.id)}" data-role="${note.role}">${leader}<text x="${f(at[0])}" y="${f(at[1])}" fill="${s.color}" font-size="${f(noteSize)}">${escapeXml(text)}</text></g>`,
      );
    }
    for (const t of c.tables) {
      const s = ROLE_STROKE[t.table.role];
      const parts: string[] = [];
      for (const cell of tableCells(c, t, line)) {
        const [a, b] = [X([cell.u0, cell.v0]), X([cell.u1, cell.v1])];
        const base = X([cell.u0 + 0.4 * (noteSize / scale), cell.v1 + 0.28 * line]);
        parts.push(
          `<rect x="${f(a[0])}" y="${f(a[1])}" width="${f(b[0] - a[0])}" height="${f(b[1] - a[1])}"/><text x="${f(base[0])}" y="${f(base[1])}" fill="${s.color}" stroke="none" font-size="${f(noteSize)}"${cell.head ? ' font-weight="bold"' : ''}>${escapeXml(cell.text)}</text>`,
        );
      }
      out.push(
        `<g data-id="${escapeXml(t.table.id)}" data-role="${t.table.role}" fill="none" stroke="${s.color}" stroke-width="${s.width}">${parts.join('')}</g>`,
      );
    }
    out.push('</g>');
  }
  if (sheet !== undefined) {
    for (const group of ['border', 'zones', 'title', 'scale-bar'] as const) {
      out.push(`<g data-sheet="${group}" stroke="#000000" fill="none">`);
      for (const p of sheet.prims.filter((x) => x.g === group)) {
        const attr = p.attr === undefined ? '' : `${p.attr} `;
        if (p.t === 'line')
          out.push(
            `<line ${attr}x1="${f(p.a[0])}" y1="${f(p.a[1])}" x2="${f(p.b[0])}" y2="${f(p.b[1])}" stroke-width="${p.w}"/>`,
          );
        else
          out.push(
            `<text ${attr}x="${f(p.at[0])}" y="${f(p.at[1])}" font-size="${p.size}"${p.middle ? ' text-anchor="middle"' : ''} stroke="none" fill="#000000">${escapeXml(p.text)}</text>`,
          );
      }
      out.push('</g>');
    }
  }
  out.push('</svg>');
  return ok(out.join('\n'));
}

/** DXF text: ASCII only (other characters become '?'), no line breaks. */
function dxfText(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?');
}

const DXF_LAYERS: readonly { readonly name: string; readonly aci: number }[] = [
  { name: 'ANNOTATION', aci: 3 },
  { name: 'HATCH', aci: 8 },
  { name: 'GRID', aci: 9 },
  { name: 'BORDER', aci: 7 },
  { name: 'TITLE', aci: 7 },
];

/** The drawing as DXF R12 (AC1009) in millimeters: views laid out like the SVG sheet. */
export function drawingDxf(
  d: ResolvedDrawing,
  options: SheetOptions = {},
): Result<string, ModelingError> {
  const planned = plan(d, options);
  if (!planned.ok) return planned;
  const { cells, size, line, scale, sheet } = planned.value;
  const unit = sheet === undefined ? 1000 : scale;
  const width = sheet?.w ?? size[0] * unit;
  const height = sheet?.h ?? size[1] * unit;
  const ox = sheet?.ox ?? 0;
  const oy = sheet?.oy ?? 0;
  const n = (x: number) => (Math.round(x * 1e4) / 1e4).toString();
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), String(value));
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1009');
  g(9, '$INSUNITS');
  g(70, 4);
  g(9, '$EXTMIN');
  g(10, 0);
  g(20, 0);
  g(9, '$EXTMAX');
  g(10, n(width));
  g(20, n(height));
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'TABLES');
  const linetypes: readonly [string, string, readonly number[]][] = [
    ['CONTINUOUS', 'Solid line', []],
    ['DASHED', '__ __ __', [3, -1.5]],
    ['DASHDOT', '__ . __ .', [6, -1.5, 0, -1.5]],
  ];
  g(0, 'TABLE');
  g(2, 'LTYPE');
  g(70, linetypes.length);
  for (const [name, text, dashes] of linetypes) {
    g(0, 'LTYPE');
    g(2, name);
    g(70, 0);
    g(3, text);
    g(72, 65);
    g(73, dashes.length);
    g(
      40,
      dashes.reduce((a, b) => a + Math.abs(b), 0),
    );
    for (const dash of dashes) g(49, dash);
  }
  g(0, 'ENDTAB');
  const roles = Object.keys(ROLE_STROKE) as DrawingRole[];
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, roles.length + DXF_LAYERS.length);
  for (const layer of [...roles.map((r) => r.toUpperCase()), ...DXF_LAYERS.map((l) => l.name)]) {
    const s = ROLE_STROKE[layer.toLowerCase() as DrawingRole];
    g(0, 'LAYER');
    g(2, layer);
    g(70, 0);
    g(62, s?.aci ?? DXF_LAYERS.find((l) => l.name === layer)?.aci ?? 3);
    g(6, s?.linetype ?? 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'ENTITIES');
  const text = (layer: string, p: Point2, h: number, value: string) => {
    g(0, 'TEXT');
    g(8, layer);
    g(10, n(p[0]));
    g(20, n(p[1]));
    g(30, 0);
    g(40, n(h));
    g(1, dxfText(value));
  };
  const segment = (layer: string, a: Point2, b: Point2) => {
    g(0, 'LINE');
    g(8, layer);
    g(10, n(a[0]));
    g(20, n(a[1]));
    g(30, 0);
    g(11, n(b[0]));
    g(21, n(b[1]));
    g(31, 0);
  };
  for (const c of cells) {
    const content = cellContent(d, options, c, cells);
    if (!content.ok) return content;
    const k = content.value;
    const sheetPoint = mapper(c, unit, ox, oy);
    const X = (p: Point2): Point2 => {
      const q = sheetPoint(p);
      return [q[0], height - q[1]];
    };
    const span = Math.max((c.box[2] - c.box[0]) * c.k, (c.box[3] - c.box[1]) * c.k, 0.1);
    const label = sheet === undefined ? 0.012 * span * unit : 2.2;
    const gap = sheet === undefined ? 0.01 * span * unit : 1.2;
    const noteSize = sheet === undefined ? 0.8 * line * unit : NOTE_MM;
    text(
      'ANNOTATION',
      sheet === undefined
        ? X([c.box[0], c.box[3] + (0.04 * span) / c.k])
        : [X([c.box[0], c.box[3]])[0], X([c.box[0], c.box[3]])[1] + 2],
      sheet === undefined ? 0.02 * span * unit : 3,
      titleText(c),
    );
    if (k.grid !== undefined) {
      const box = 'detail' in c.view ? c.view.detail.box : c.box;
      for (const u of k.grid.u) {
        const [a, b] = [X([u, box[1]]), X([u, box[3]])];
        segment('GRID', a, b);
        text('GRID', [a[0], a[1] - 2.4], 1.6, String(Math.round(u * 1000)));
      }
      for (const v of k.grid.v) {
        const [a, b] = [X([box[0], v]), X([box[2], v])];
        segment('GRID', a, b);
        text('GRID', [a[0] - 4, a[1] - 0.6], 1.6, String(Math.round(v * 1000)));
      }
    }
    for (const [a, b] of k.hatches) segment('HATCH', X(a), X(b));
    for (const x of k.curves) {
      g(0, 'POLYLINE');
      g(8, x.role.toUpperCase());
      g(66, 1);
      g(10, 0);
      g(20, 0);
      g(30, 0);
      g(70, x.closed ? 1 : 0);
      for (const p of x.points) {
        const q = X(p);
        g(0, 'VERTEX');
        g(8, x.role.toUpperCase());
        g(10, n(q[0]));
        g(20, n(q[1]));
        g(30, 0);
      }
      g(0, 'SEQEND');
      g(8, x.role.toUpperCase());
    }
    const placed = placeLabels(
      k.points.map((p) => ({ at: X(p.at), text: pointLabel(p.id, c.view.id) })),
      label,
      gap,
      false,
    );
    for (const [i, p] of k.points.entries()) {
      const q = X(p.at);
      const l = placed[i] as PlacedLabel;
      const layer = p.role.toUpperCase();
      g(0, 'POINT');
      g(8, layer);
      g(10, n(q[0]));
      g(20, n(q[1]));
      g(30, 0);
      if (l.leader) segment(layer, q, l.at);
      text(layer, l.at, label, pointLabel(p.id, c.view.id));
    }
    for (const dim of k.dimensions) {
      const [a, b] = [X(dim.from), X(dim.to)];
      segment('ANNOTATION', a, b);
      text('ANNOTATION', [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], label, dimensionLabel(dim));
    }
    for (const mark of k.marks) {
      const [a, b] = [X([mark.box[0], mark.box[1]]), X([mark.box[2], mark.box[3]])];
      const corners: Point2[] = [a, [b[0], a[1]], b, [a[0], b[1]]];
      for (const [i, p] of corners.entries())
        segment('ANNOTATION', p, corners[(i + 1) % 4] as Point2);
      text('ANNOTATION', [a[0], a[1] - 4], 3, mark.label);
    }
    for (const note of k.placed) {
      const layer = note.role.toUpperCase();
      const at = X(note.at as Point2);
      const anchor = noteAnchor(d, note);
      if (note.balloon === true) {
        const edge = anchor === undefined ? undefined : balloonEdge(X(anchor), at);
        if (anchor !== undefined && edge !== undefined) segment(layer, X(anchor), edge);
        g(0, 'CIRCLE');
        g(8, layer);
        g(10, n(at[0]));
        g(20, n(at[1]));
        g(30, 0);
        g(40, BALLOON_MM);
        text(
          layer,
          [at[0] - 0.3 * noteSize * note.text.length, at[1] - 0.35 * noteSize],
          noteSize,
          note.text,
        );
        continue;
      }
      if (anchor !== undefined) segment(layer, X(anchor), at);
      for (const [i, textLine] of `${note.id}: ${note.text}`.split(/\r?\n/).entries())
        text(layer, [at[0], at[1] - i * 1.2 * noteSize], noteSize, textLine);
    }
    for (const [i, { note, text: value, first }] of c.notes.entries()) {
      const layer = note.role.toUpperCase();
      const at = X([c.box[0], c.box[1] - (i + 1) * line]);
      const anchor = first ? noteAnchor(d, note) : undefined;
      if (anchor !== undefined) segment(layer, X(anchor), at);
      text(layer, at, noteSize, value);
    }
    for (const t of c.tables) {
      const layer = t.table.role.toUpperCase();
      for (const cell of tableCells(c, t, line)) {
        const [a, b] = [X([cell.u0, cell.v0]), X([cell.u1, cell.v1])];
        const corners: Point2[] = [a, [b[0], a[1]], b, [a[0], b[1]]];
        for (const [i, p] of corners.entries()) segment(layer, p, corners[(i + 1) % 4] as Point2);
        const base = X([cell.u0 + 0.4 * (noteSize / unit), cell.v1 + 0.28 * line]);
        text(layer, base, noteSize, cell.text);
      }
    }
  }
  if (sheet !== undefined) {
    for (const p of sheet.prims) {
      const layer = p.g === 'border' || p.g === 'zones' ? 'BORDER' : 'TITLE';
      if (p.t === 'line') segment(layer, [p.a[0], height - p.a[1]], [p.b[0], height - p.b[1]]);
      else {
        const shift = p.middle ? 0.3 * p.size * p.text.length : 0;
        text(layer, [p.at[0] - shift, height - p.at[1]], p.size, p.text);
      }
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return ok(`${out.join('\n')}\n`);
}
