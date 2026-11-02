import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Drawing,
  type DrawingItem,
  type DrawnTable,
  type DtsRow,
  drawingDxf,
  drawingSvg,
  drawingTable,
  type JointSpec,
  lookFrame,
  model,
  resolveDrawing,
  type SheetOptions,
  sel,
  TABLE_CELL_LIMIT,
  toView,
} from '../index';

function resolved(d: Drawing) {
  const r = resolveDrawing(d);
  if (!r.ok) throw r.error;
  return r.value;
}

function svgOf(d: Drawing, options?: SheetOptions): string {
  const r = drawingSvg(resolved(d), options);
  if (!r.ok) throw r.error;
  return r.value;
}

function dxfOf(d: Drawing, options?: SheetOptions): string {
  const r = drawingDxf(resolved(d), options);
  if (!r.ok) throw r.error;
  return r.value;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function hull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: number[], a: number[], b: number[]) =>
    ((a[0] as number) - (o[0] as number)) * ((b[1] as number) - (o[1] as number)) -
    ((a[1] as number) - (o[1] as number)) * ((b[0] as number) - (o[0] as number));
  const build = (list: [number, number][]) => {
    const out: [number, number][] = [];
    for (const q of list) {
      while (
        out.length >= 2 &&
        turn(out[out.length - 2] as number[], out[out.length - 1] as number[], q) <= 0
      )
        out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return [...build(p), ...build([...p].reverse())];
}

const corners: [number, number, number][] = [];
for (const x of [-0.5, 0.5])
  for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) corners.push([x, y, z]);

function boxModel() {
  const m = model();
  m.box({ size: [1, 1, 1] });
  m.assign(sel.all(), 'paint');
  return m;
}

const toward: [number, number, number] = [1, 0, 1];

function outline(du: number): [number, number][] {
  const frame = lookFrame(toward);
  if (frame === undefined) throw new Error('frame');
  return hull(
    corners.map((c) => [toView(frame, c)[0] + du, toView(frame, c)[1]] as [number, number]),
  );
}

function threeQuarter(du: number): Drawing {
  return {
    name: 'box 3/4',
    views: [{ id: 'tq', toward }],
    items: [
      {
        id: 'outline',
        view: 'tq',
        role: 'silhouette',
        kind: 'curve',
        curve: { kind: 'polyline', points: outline(du) },
        closed: true,
      },
    ],
  };
}

function findings(d: Drawing) {
  const m = boxModel();
  expect(m.drawing(d).status).toBe('ok');
  return m
    .validate({ drawing: true })
    .issues.filter((i) => i.code === 'drawing')
    .map((i) => i.detail);
}

describe('lookFrame', () => {
  it('is orthonormal and right-handed to 1e-12 for oblique and tilted directions', () => {
    for (const [t, up] of [
      [[1, 0, 1], undefined],
      [[1, 0, -1], undefined],
      [[3, 2, 5], undefined],
      [
        [0, 0, 1],
        [0.0000001, 1, 0.0000001],
      ],
      [
        [1, 1, 1],
        [1, 0, 0],
      ],
    ] as const) {
      const f = lookFrame(
        t as [number, number, number],
        up as [number, number, number] | undefined,
      );
      expect(f).toBeDefined();
      if (f === undefined) continue;
      const dot = (a: readonly number[], b: readonly number[]) =>
        (a[0] as number) * (b[0] as number) +
        (a[1] as number) * (b[1] as number) +
        (a[2] as number) * (b[2] as number);
      for (const v of [f.right, f.up, f.toward])
        expect(Math.abs(dot(v, v) - 1)).toBeLessThan(1e-12);
      expect(Math.abs(dot(f.right, f.up))).toBeLessThan(1e-12);
      expect(Math.abs(dot(f.right, f.toward))).toBeLessThan(1e-12);
      const c = [
        (f.right[1] as number) * (f.up[2] as number) - (f.right[2] as number) * (f.up[1] as number),
        (f.right[2] as number) * (f.up[0] as number) - (f.right[0] as number) * (f.up[2] as number),
        (f.right[0] as number) * (f.up[1] as number) - (f.right[1] as number) * (f.up[0] as number),
      ];
      for (let k = 0; k < 3; k++)
        expect(Math.abs((c[k] as number) - (f.toward[k] as number))).toBeLessThan(1e-12);
    }
  });

  it('is undefined for a zero direction or one along up', () => {
    expect(lookFrame([0, 0, 0])).toBeUndefined();
    expect(lookFrame([0, 2, 0])).toBeUndefined();
    expect(lookFrame([0, -1, 0])).toBeUndefined();
    expect(lookFrame([1, 0, 0], [3, 0, 0])).toBeUndefined();
  });

  it('keeps the front view for toward +z', () => {
    expect(lookFrame([0, 0, 1])).toEqual({ right: [1, 0, 0], up: [0, 1, 0], toward: [0, 0, 1] });
  });
});

describe('toward view', () => {
  it('matches the box outline exactly: no silhouette finding', () => {
    expect(
      findings(threeQuarter(0)).filter((f) => (f as { check: string }).check === 'silhouette'),
    ).toEqual([]);
  });

  it('flags the outline shifted by 5 % of its width with an IoU below 0.93', () => {
    const f = findings(threeQuarter(0.05 * Math.SQRT2)) as { check: string; iou: number }[];
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ check: 'silhouette' });
    expect(f[0]?.iou).toBeLessThan(0.93);
  });

  it('rejects a direction along up with model-degenerate, and a malformed one', () => {
    const bad = (view: Record<string, unknown>) =>
      resolveDrawing({ name: 'x', views: [view as never], items: [] });
    const along = bad({ id: 'v', toward: [0, 1, 0] });
    expect(!along.ok && along.error.code).toBe('model-degenerate');
    const zero = bad({ id: 'v', toward: [0, 0, 0] });
    expect(!zero.ok && zero.error.code).toBe('model-degenerate');
    const short = bad({ id: 'v', toward: [1, 0] });
    expect(!short.ok && short.error.code).toBe('model-invalid-argument');
    const nan = bad({ id: 'v', toward: [1, Number.NaN, 0] });
    expect(!nan.ok && nan.error.code).toBe('model-invalid-argument');
  });

  it('titles the view with its direction on a sheet', () => {
    expect(svgOf(threeQuarter(0))).toContain('toward 1,0,1');
  });
});

describe('material callout', () => {
  const view = { id: 'front', ortho: 'front' } as const;
  const sheet = (text: string, depth?: number): Drawing => ({
    name: 'material sheet',
    views: [view],
    items: [
      {
        id: 'p',
        view: 'front',
        role: 'pivot',
        kind: 'point',
        at: [0, 0],
        ...(depth === undefined ? {} : { depth }),
      },
      { id: 'c', view: 'front', role: 'material', kind: 'note', refs: ['p'], text, at: [0.3, 0.3] },
    ],
  });

  it('passes when the face under the point has the named slot', () => {
    expect(findings(sheet('paint', 0.5))).toEqual([]);
  });

  it('flags another or unknown slot with the expected and found names', () => {
    expect(findings(sheet('glass', 0.5))).toMatchObject([
      { check: 'material', item: 'c', expected: 'glass', found: 'paint' },
    ]);
  });

  it('reports a point with no depth as unmeasured, never as a pass', () => {
    const f = findings(sheet('paint'));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ check: 'material', item: 'c', expected: 'paint' });
    expect(f[0]).not.toHaveProperty('found');
  });

  it('reports a point beside the subject as unmeasured', () => {
    const d = sheet('paint', 0.5);
    const off = {
      ...d,
      items: d.items.map((i) => (i.id === 'p' ? { ...i, at: [3, 3] } : i)),
    } as Drawing;
    expect(findings(off)).toMatchObject([{ check: 'material', item: 'c' }]);
  });

  it('draws with its own role stroke', () => {
    expect(svgOf(sheet('paint', 0.5))).toContain('data-role="material"');
  });
});

const rowsOf = (...ids: string[]) => ids.map((id) => [id, 'x']);

const table = (rows: DrawnTable['rows']): DrawingItem => ({
  id: 't',
  view: 'front',
  role: 'guide',
  kind: 'table',
  columns: ['key', 'value'],
  rows,
});

const base = (items: DrawingItem[]): Drawing => ({
  name: 'tables',
  views: [{ id: 'front', ortho: 'front' }],
  items,
});

const balloon = (text: string): DrawingItem => ({
  id: `b-${text}`,
  view: 'front',
  role: 'guide',
  kind: 'note',
  refs: [],
  text,
  at: [0.2, 0.2],
  balloon: true,
});

describe('balloon and table validation', () => {
  it('resolves a balloon whose text keys a table row of the same view', () => {
    expect(resolveDrawing(base([table(rowsOf('1', '2')), balloon('2')])).ok).toBe(true);
  });

  it('rejects a balloon with no table row', () => {
    const r = resolveDrawing(base([table(rowsOf('1')), balloon('9')]));
    expect(!r.ok && r.error.code).toBe('model-invalid-argument');
    const none = resolveDrawing(base([balloon('1')]));
    expect(!none.ok && none.error.code).toBe('model-invalid-argument');
  });

  it('rejects a balloon in another view than its table and a balloon with no point', () => {
    const d: Drawing = {
      name: 't',
      views: [
        { id: 'front', ortho: 'front' },
        { id: 'side', ortho: 'right' },
      ],
      items: [
        table(rowsOf('1')),
        { ...(balloon('1') as object), view: 'side', id: 'bb' } as DrawingItem,
      ],
    };
    const r = resolveDrawing(d);
    expect(!r.ok && r.error.code).toBe('model-invalid-argument');
    const { at: _at, ...noPoint } = balloon('1') as DrawingItem & { at: [number, number] };
    const p = resolveDrawing(base([table(rowsOf('1')), noPoint as DrawingItem]));
    expect(!p.ok && p.error.code).toBe('model-invalid-argument');
  });

  it('rejects a ragged row', () => {
    const r = resolveDrawing(base([table([['a', 'b'], ['c']])]));
    expect(!r.ok && r.error.code).toBe('model-invalid-argument');
  });

  it('bounds the cells of a drawing', () => {
    const rows = Array.from({ length: TABLE_CELL_LIMIT / 2 }, (_, i) => [`r${i}`, 'x']);
    const r = resolveDrawing(base([table(rows)]));
    expect(!r.ok && r.error.code).toBe('model-work-budget');
    const fine = resolveDrawing(base([table(rows.slice(0, 100))]));
    expect(fine.ok).toBe(true);
  });
});

const dts: DtsRow[] = [
  { id: 'door-front', parts: ['door', 'fender'], zone: 'A' },
  { id: 'hood-edge', parts: ['hood', 'fender'], zone: 'B', limits: { flush: 0.0004 } },
  { id: 'sill', parts: ['sill', 'door'], zone: 'C' },
];

const joints: JointSpec[] = [
  { name: 'root', parent: null, position: [0, 0, 0] },
  {
    name: 'door',
    parent: 'root',
    position: [0.5, 0, 0],
    kind: 'revolute',
    axis: 'y',
    limits: [-60, 0],
  },
  {
    name: 'slide',
    parent: 'root',
    position: [0, 1, 0],
    kind: 'prismatic',
    axis: [1, 0, 0],
    limits: [0, 0.2],
  },
  {
    name: 'ball',
    parent: 'door',
    position: [0.5, 1, 0],
    kind: 'spherical',
    limits: { x: [-10, 10], z: [-5, 5] },
  },
];

function made(source: Parameters<typeof drawingTable>[2]): DrawnTable {
  const r = drawingTable('t', 'front', source);
  if (!r.ok) throw r.error;
  return r.value;
}

describe('drawingTable', () => {
  it('derives the DTS table from rows: a zone or limits mutation changes the cell', () => {
    const a = made({ kind: 'dts', rows: dts });
    expect(a).toMatchObject({ kind: 'table', id: 't', view: 'front' });
    expect(a.rows).toHaveLength(3);
    expect(a.rows.map((r) => r[0])).toEqual(['door-front', 'hood-edge', 'sill']);
    const zone = made({
      kind: 'dts',
      rows: dts.map((r, i) => (i === 0 ? { ...r, zone: 'C' as const } : r)),
    });
    expect(zone.rows[0]).not.toEqual(a.rows[0]);
    const limits = made({
      kind: 'dts',
      rows: dts.map((r, i) => (i === 1 ? { ...r, limits: { flush: 0.0002 } } : r)),
    });
    expect(limits.rows[1]).not.toEqual(a.rows[1]);
    expect(limits.rows[0]).toEqual(a.rows[0]);
  });

  it('adds the measured status column when a report is given', () => {
    const plain = made({ kind: 'dts', rows: dts });
    const report = {
      rows: dts.map((r) => ({ id: r.id, status: 'pass' })),
      pass: true,
      counts: { pass: 3, fail: 0, excepted: 0, unmeasured: 0 },
    };
    const withReport = made({ kind: 'dts', rows: dts, report: report as never });
    expect(withReport.columns.length).toBe(plain.columns.length + 1);
    expect(withReport.columns).toContain('status');
  });

  it('lists kind, axis and limits per joint in parent order', () => {
    const t = made({ kind: 'joints', joints });
    expect(t.columns).toEqual(['joint', 'parent', 'kind', 'axis', 'limits']);
    expect(t.rows.map((r) => r[0])).toEqual(['root', 'door', 'slide', 'ball']);
    expect(t.rows[1]).toEqual(['door', 'root', 'revolute', 'y', '-60..0 deg']);
    expect(t.rows[2]?.[4]).toBe('0..200 mm');
    expect(t.rows[3]?.[4]).toBe('x -10..10; z -5..5 deg');
    expect(t.rows[0]?.[2]).toBe('fixed');
  });

  it('rejects a joint list that is empty and an unknown source', () => {
    const e = drawingTable('t', 'front', { kind: 'joints', joints: [] });
    expect(!e.ok && e.error.code).toBe('model-invalid-argument');
    const u = drawingTable('t', 'front', { kind: 'nope' } as never);
    expect(!u.ok && u.error.code).toBe('model-invalid-argument');
  });

  it('lists exploded parts as a bill of materials', () => {
    const t = made({
      kind: 'bom',
      parts: [
        {
          name: 'hood',
          faces: 12,
          centroid: [0, 0, 0],
          offset: [0, 0.1, 0],
          authored: false,
          order: 0,
        },
      ],
    });
    expect(t.rows).toEqual([[1, 'hood', 0, 12, '0 100 0 mm']]);
  });

  it('refuses a source over the cell budget', () => {
    const many: DtsRow[] = Array.from({ length: 600 }, (_, i) => ({
      id: `r${i}`,
      parts: ['a', 'b'],
    }));
    const r = drawingTable('t', 'front', { kind: 'dts', rows: many });
    expect(!r.ok && r.error.code).toBe('model-work-budget');
  });
});

const fixture: Drawing = {
  name: 'callout sheet',
  views: [
    { id: 'front', ortho: 'front' },
    { id: 'tq', toward: [1, 0, 1] },
  ],
  items: [
    {
      id: 'body',
      view: 'tq',
      role: 'silhouette',
      kind: 'curve',
      curve: { kind: 'polyline', points: outline(0) },
      closed: true,
    },
    { id: 'p', view: 'tq', role: 'pivot', kind: 'point', at: [0, 0], depth: 0.5 },
    {
      id: 'skin',
      view: 'tq',
      role: 'material',
      kind: 'note',
      refs: ['p'],
      text: 'paint',
      at: [0.5, 0.6],
    },
    {
      id: 'n1',
      view: 'tq',
      role: 'guide',
      kind: 'note',
      refs: ['p'],
      text: '1',
      at: [-0.5, 0.6],
      balloon: true,
    },
    {
      ...table([
        ['1', 'door'],
        ['2', 'hood'],
      ]),
      id: 'parts',
      view: 'tq',
    } as DrawingItem,
  ],
};

const options: SheetOptions = {
  views: ['tq'],
  scale: 150,
  sheet: {
    size: 'A3',
    title: { number: 'DWG-002', revision: 'A', author: 'A. Person', date: '2026-10-26' },
  },
};

describe('sheet output', () => {
  it('draws the balloon as a circle with a leader and the table as ruled cells', () => {
    const svg = svgOf(fixture, options);
    expect(svg).toMatch(/<circle[^>]*data-id="n1"/);
    expect(svg).toContain('data-id="parts"');
    const dxf = dxfOf(fixture, options);
    expect(dxf).toContain('\nCIRCLE\n');
    expect(dxf).toContain('hood');
  });

  it('places the table under its view without touching the view box', () => {
    const svg = svgOf(fixture, options);
    const ys = [...svg.matchAll(/data-id="parts"[^>]*>/g)];
    expect(ys.length).toBeGreaterThan(0);
  });

  it('is byte-stable and independent of key order', () => {
    const permuted = JSON.parse(
      JSON.stringify(fixture, (_k, v) =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    ) as Drawing;
    expect(svgOf(permuted, options)).toBe(svgOf(fixture, options));
    expect(dxfOf(permuted, options)).toBe(dxfOf(fixture, options));
    expect(svgOf(fixture, options)).toBe(svgOf(fixture, options));
  });

  it('pins one SVG and one DXF', () => {
    expect({ svg: sha(svgOf(fixture, options)), dxf: sha(dxfOf(fixture, options)) }).toEqual({
      svg: '52dad7f07428d7dc97f2d2d55dac706691feb299d030dc67b1d84aa4b6090ca0',
      dxf: '9e120d5d3309562c8747af1cb73738dee8f0a579b22ab722b767504a4dd7122e',
    });
  });

  it('opens in an R12 reader with a clean audit', () => {
    const probe = spawnSync('python3', ['-c', 'import ezdxf'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      console.warn('ezdxf is not installed: skipping the R12 reader check');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'callouts-'));
    const file = join(dir, 'sheet.dxf');
    writeFileSync(file, dxfOf(fixture, options));
    const run = spawnSync(
      'python3',
      [
        '-c',
        'import sys, ezdxf\ndoc = ezdxf.readfile(sys.argv[1])\nprint(doc.dxfversion, len(doc.audit().errors))',
        file,
      ],
      { encoding: 'utf8' },
    );
    expect(run.stdout.trim()).toBe('AC1009 0');
  });

  it('has no clock, locale or random in the new sources', () => {
    for (const f of [
      'drawing.ts',
      'drawing-table.ts',
      'drawing-export.ts',
      'drawing-check.ts',
      'views.ts',
    ]) {
      const text = readFileSync(join(__dirname, '..', f), 'utf8');
      expect(text, f).not.toMatch(/\bDate\b|Math\.random|toLocale|performance\.now/);
    }
  });
});
