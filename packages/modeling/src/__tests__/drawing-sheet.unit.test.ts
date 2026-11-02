import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Drawing,
  type DrawingItem,
  drawingDxf,
  drawingSvg,
  hatchSpacing,
  model,
  type ResolvedDrawing,
  resolveDrawing,
  type SheetOptions,
} from '../index';

function resolved(d: Drawing): ResolvedDrawing {
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

const car: Drawing = {
  name: 'car',
  views: [{ id: 'side', ortho: 'right' }],
  items: [
    {
      id: 'body',
      view: 'side',
      role: 'silhouette',
      kind: 'curve',
      curve: { kind: 'polyline', points: rect(-2, 0, 2, 1.4) },
      closed: true,
    },
  ],
};

const detailed: Drawing = {
  name: 'detail sheet',
  views: [
    { id: 'front', ortho: 'front' },
    { id: 'A', of: 'front', detail: { box: [0, 0, 0.2, 0.2], scale: 500 } },
  ],
  items: [
    {
      id: 'near',
      view: 'front',
      role: 'feature',
      kind: 'curve',
      curve: {
        kind: 'polyline',
        points: [
          [0.05, 0.05],
          [0.15, 0.1],
        ],
      },
    },
    {
      id: 'far',
      view: 'front',
      role: 'feature',
      kind: 'curve',
      curve: {
        kind: 'polyline',
        points: [
          [0.8, 0.8],
          [0.9, 0.9],
        ],
      },
    },
    {
      id: 'frame',
      view: 'front',
      role: 'silhouette',
      kind: 'curve',
      curve: { kind: 'polyline', points: rect(0, 0, 1, 1) },
      closed: true,
    },
  ],
};

const full: Drawing = {
  name: 'issued sheet',
  sources: [{ title: 'fixture' }],
  views: [
    { id: 'front', ortho: 'front' },
    { id: 'cut', section: { axis: 'z', at: 0 } },
    { id: 'A', of: 'front', detail: { box: [0, 0, 0.2, 0.2], scale: 500 } },
  ],
  items: [
    ...(detailed.items.filter((i) => i.view === 'front') as DrawingItem[]),
    ...(ring.items as DrawingItem[]),
    { id: 'tip', view: 'front', role: 'pivot', kind: 'point', at: [0.1, 0.1] },
    { id: 'root', view: 'front', role: 'pivot', kind: 'point', at: [0.3, 0.3] },
    {
      id: 'call',
      view: 'front',
      role: 'break',
      kind: 'note',
      refs: ['root'],
      text: 'shut line',
      at: [0.6, 0.6],
    },
  ],
};

const fullOptions: SheetOptions = {
  views: ['front', 'cut', 'A'],
  columns: 3,
  sheet: {
    size: 'A3',
    title: { number: 'DWG-001', revision: 'B', author: 'A. Person', date: '2026-10-26' },
  },
  grid: 0.1,
  scale: 100,
  measured: {
    front: [
      [
        [0, 0],
        [1, 1],
      ],
    ],
  },
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const num = (s: string) => Number(s);

describe('section hatching', () => {
  it('hatches the even-odd interior of closed section curves, one spacing shared with the capture tool', () => {
    const r = resolved(ring);
    expect(r.hatches.map((h) => h.view)).toEqual(['cut']);
    const segments = r.hatches[0]?.segments ?? [];
    expect(segments.length).toBeGreaterThan(10);
    const outsideInner = ([x, y]: readonly [number, number]) =>
      !(x > 0.3 && x < 0.7 && y > 0.3 && y < 0.7);
    for (const [a, b] of segments) {
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      expect(mid[0]).toBeGreaterThan(0);
      expect(mid[0]).toBeLessThan(1);
      expect(mid[1]).toBeGreaterThan(0);
      expect(mid[1]).toBeLessThan(1);
      expect(outsideInner(mid)).toBe(true);
    }
    const spacing = hatchSpacing(rect(0, 0, 1, 1).map((p, i, a) => [p, a[(i + 1) % 4]] as never));
    expect(spacing).toBeCloseTo(1 / 40, 9);
    expect(svgOf(ring)).toContain('data-role="hatch"');
    expect(dxfOf(ring)).toContain('\nHATCH\n');
  });

  it('draws no hatch for a drawing without closed section curves', () => {
    expect(svgOf(car)).not.toContain('data-role="hatch"');
    expect(resolved(car).hatches).toEqual([]);
  });
});

describe('sheet frame', () => {
  const zones = (svg: string) => svg.match(/data-zone="/g)?.length ?? 0;

  it('sets the ISO sheet size, border and 8 x 6 zone marks on A3 landscape', () => {
    const svg = svgOf(car, { sheet: { size: 'A3' } });
    expect(svg).toContain('width="420mm" height="297mm"');
    expect(svg).toContain('viewBox="0 0 420 297"');
    expect(zones(svg)).toBe(14);
    expect(svg).toContain('data-border');
  });

  it('rejects an explicit scale that does not fit, with needed and available millimeters', () => {
    const r = drawingSvg(resolved(car), { sheet: { size: 'A3' }, scale: 1000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-precondition');
    const detail = r.error.detail as { needed: number[]; available: number[] };
    expect(detail.needed[0]).toBeGreaterThan(detail.available[0] as number);
    expect(detail.available).toEqual([390, 237]);
  });

  it('chooses the largest ISO 5455 scale that fits: a 4 m car on A3 is 1:20', () => {
    const svg = svgOf(car, { sheet: { size: 'A3' } });
    expect(svg).toContain('>1:20<');
  });

  it('rejects bad sheet inputs', () => {
    const code = (o: SheetOptions) => {
      const r = drawingSvg(resolved(car), o);
      return r.ok ? 'ok' : r.error.code;
    };
    expect(code({ sheet: { size: 'A9' as never } })).toBe('model-invalid-argument');
    expect(code({ sheet: { size: 'A3', orientation: 'tilted' as never } })).toBe(
      'model-invalid-argument',
    );
    expect(code({ sheet: { size: 'A3', title: { author: 3 as never } } })).toBe(
      'model-invalid-argument',
    );
    expect(code({ scale: 0 })).toBe('model-invalid-argument');
  });
});

describe('title block and scale bar', () => {
  it('prints the caller title fields and is byte-stable', () => {
    const svg = svgOf(full, fullOptions);
    for (const text of ['issued sheet', 'DWG-001', 'B', 'A. Person', '2026-10-26', 'A3'])
      expect(svg).toContain(`>${text}<`);
    expect(svgOf(full, fullOptions)).toBe(svg);
  });

  it('is independent of Record key order', () => {
    const other = {
      ...fullOptions,
      measured: { cut: [], front: fullOptions.measured?.front ?? [] },
    };
    const swapped = {
      ...fullOptions,
      measured: { front: fullOptions.measured?.front ?? [], cut: [] },
    };
    expect(svgOf(full, other)).toBe(svgOf(full, swapped));
    expect(dxfOf(full, other)).toBe(dxfOf(full, swapped));
  });

  it('has no clock, locale or random in the export', () => {
    const src = readFileSync(join(__dirname, '..', 'drawing-export.ts'), 'utf8');
    expect(src).not.toMatch(/Date|Math\.random|toLocale|Intl\./);
  });

  it('draws a scale bar whose length is its meters times the scale', () => {
    const svg = svgOf(car, { sheet: { size: 'A3' } });
    const bar = svg.match(/<line data-bar-m="([\d.]+)" x1="([\d.-]+)" y1="[\d.-]+" x2="([\d.-]+)"/);
    expect(bar).not.toBeNull();
    const metres = num(bar?.[1] ?? '0');
    const length = num(bar?.[3] ?? '0') - num(bar?.[2] ?? '0');
    expect(Math.abs(length - metres * 50)).toBeLessThan(0.01);
    expect(length).toBeLessThanOrEqual(100);
    expect(metres).toBe(2);
  });
});

describe('view grid', () => {
  const box: Drawing = {
    name: 'grid',
    views: [{ id: 'front', ortho: 'front' }],
    items: [
      {
        id: 'diag',
        view: 'front',
        role: 'feature',
        kind: 'curve',
        curve: {
          kind: 'polyline',
          points: [
            [0, 0],
            [0.45, 0.45],
          ],
        },
      },
    ],
  };

  it('draws a line at each multiple of the spacing, per axis', () => {
    const svg = svgOf(box, { grid: 0.1 });
    expect(svg.match(/data-grid="u"/g)).toHaveLength(5);
    expect(svg.match(/data-grid="v"/g)).toHaveLength(5);
    expect(dxfOf(box, { grid: 0.1 })).toContain('\nGRID\n');
  });

  it('rejects a spacing that is not positive and finite', () => {
    for (const grid of [0, -0.1, Number.NaN]) {
      const r = drawingSvg(resolved(box), { grid });
      expect(r.ok ? 'ok' : r.error.code).toBe('model-invalid-argument');
    }
  });
});

describe('detail view', () => {
  const group = (svg: string, id: string) => {
    const start = svg.indexOf(`<g data-view="${id}"`);
    const next = svg.indexOf('<g data-view=', start + 1);
    return svg.slice(start, next < 0 ? undefined : next);
  };

  it('shows only what falls in its box, and the parent carries the detail mark', () => {
    const svg = svgOf(detailed, { scale: 100 });
    const a = group(svg, 'A');
    expect(a).toContain('data-id="near"');
    expect(a).not.toContain('data-id="far"');
    expect(group(svg, 'front')).toContain('data-detail-mark="A"');
    expect(a).toContain('1:2');
  });

  it('is magnified by detail scale over sheet scale', () => {
    const svg = svgOf(detailed, { scale: 100 });
    const pts = (g: string, id: string) =>
      (g.match(new RegExp(`data-id="${id}" points="([^"]+)"`))?.[1] ?? '')
        .split(' ')
        .map((p) => p.split(',').map(num) as [number, number]);
    const parent = pts(group(svg, 'front'), 'near');
    const detail = pts(group(svg, 'A'), 'near');
    const span = (p: [number, number][]) => Math.abs((p[1]?.[0] ?? 0) - (p[0]?.[0] ?? 0));
    expect(span(detail) / span(parent)).toBeCloseTo(5, 1);
  });

  it('rejects bad detail declarations', () => {
    const bad = (view: unknown) => {
      const r = resolveDrawing({ ...detailed, views: [detailed.views[0] as never, view as never] });
      return r.ok ? 'ok' : r.error.code;
    };
    expect(bad({ id: 'A', of: 'nope', detail: { box: [0, 0, 1, 1], scale: 500 } })).toBe(
      'model-invalid-argument',
    );
    expect(bad({ id: 'A', of: 'front', detail: { box: [0, 0, 0, 1], scale: 500 } })).toBe(
      'model-invalid-argument',
    );
    expect(bad({ id: 'A', of: 'front', detail: { box: [0, 0, 1, 1], scale: 0 } })).toBe(
      'model-invalid-argument',
    );
    const nested = resolveDrawing({
      ...detailed,
      views: [
        ...detailed.views,
        { id: 'B', of: 'A', detail: { box: [0, 0, 0.1, 0.1], scale: 1000 } } as never,
      ],
    });
    expect(nested.ok).toBe(false);
  });

  it('counts items on a detail id as items of the parent view in checks', () => {
    const views: Drawing['views'] = [
      { id: 'front', ortho: 'front' },
      { id: 'A', of: 'front', detail: { box: [-0.5, -0.5, 0, 0], scale: 500 } },
    ];
    const outline = (view: string, h: number): DrawingItem => ({
      id: 'outline',
      view,
      role: 'silhouette',
      kind: 'curve',
      curve: { kind: 'polyline', points: rect(-h, -h, h, h) },
      closed: true,
      tolerance: 0.01,
    });
    const findings = (view: string) => {
      const fresh = model();
      fresh.box({ size: [1, 1, 1] });
      expect(fresh.drawing({ name: 'd', views, items: [outline(view, 0.7)] }).status).toBe('ok');
      return fresh
        .validate({ drawing: true })
        .issues.filter((i) => i.code === 'drawing')
        .map((i) => {
          const { view: _view, ...rest } = i.detail as Record<string, unknown>;
          return rest;
        });
    };
    expect(findings('front').length).toBeGreaterThan(0);
    expect(findings('A')).toEqual(findings('front'));
  });
});

describe('placed notes', () => {
  it('draws a placed note at its point with a leader from the first ref', () => {
    const svg = svgOf(full, { views: ['front'], scale: 100 });
    const note = svg.split('\n').find((l) => l.includes('data-id="call"')) ?? '';
    expect(note).toContain('<polyline');
    const root = svg.match(/data-id="root" cx="([\d.]+)" cy="([\d.]+)"/);
    const text = note.match(/<text x="([\d.]+)" y="([\d.]+)"/);
    const leader = note.match(/points="([\d.]+),([\d.]+) /);
    expect(leader?.slice(1, 3)).toEqual(root?.slice(1, 3));
    const tip = svg.match(/data-id="tip" cx="([\d.]+)" cy="([\d.]+)"/);
    expect(text).not.toBeNull();
    expect(tip).not.toBeNull();
    const plain = svgOf(
      {
        ...full,
        items: full.items.map((i) => {
          if (i.kind !== 'note') return i;
          const { at: _at, ...rest } = i;
          return rest;
        }),
      },
      { views: ['front'], scale: 100 },
    );
    const unplaced = plain.split('\n').find((l) => l.includes('data-id="call"')) ?? '';
    expect(unplaced).not.toBe(note);
  });
});

describe('golden bytes', () => {
  it('pins one SVG and one DXF', () => {
    const svg = svgOf(full, fullOptions);
    const dxf = dxfOf(full, fullOptions);
    expect({ svg: sha(svg), dxf: sha(dxf) }).toEqual({
      svg: '022e9724ad54b3b4549f71da19a0887fdc4bcc470a9ff0a21c682cd2db265204',
      dxf: '1f8a0552672f7c0fc0ba04f451129e79a9ab6802abe5497ba989721617ac7666',
    });
  });

  it('opens in an R12 reader with a clean audit', () => {
    const probe = spawnSync('python3', ['-c', 'import ezdxf'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      console.warn('ezdxf is not installed: skipping the R12 reader check');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'sheet-'));
    const file = join(dir, 'sheet.dxf');
    writeFileSync(file, dxfOf(full, fullOptions));
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
});
