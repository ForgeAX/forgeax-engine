import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type Drawing,
  type DrawingItem,
  drawingDxf,
  drawingSvg,
  type ExplodedPart,
  explodeDrawing,
  explodeMesh,
  lookFrame,
  meshViewEdges,
  model,
  ORTHO_VIEWS,
  resolveDrawing,
} from '../index';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function parts() {
  const m = model();
  m.box({ size: [1, 1, 1], tag: 'body' });
  m.box({ size: [0.3, 0.3, 0.3], center: [0, 0.8, 0], tag: 'cap' });
  m.box({ size: [0.3, 0.3, 0.3], center: [0.9, 0, 0], tag: 'side' });
  m.box({ size: [0.3, 0.3, 0.3], center: [0, 0, -0.9], tag: 'rear' });
  return m.editMesh;
}

function base(explode: object = { by: 'tag', distance: 0.6, order: [['cap'], ['side', 'rear']] }) {
  return {
    name: 'exploded',
    views: [
      { id: 'tq', toward: [1, 1, 1] },
      { id: 'ex', of: 'tq', explode },
    ],
    items: [],
  } as unknown as Drawing;
}

function exploded(d: Drawing = base()): Drawing {
  const r = explodeDrawing(parts(), d);
  if (!r.ok) throw r.error;
  return r.value;
}

function sheets(d: Drawing) {
  const r = resolveDrawing(d);
  if (!r.ok) throw r.error;
  const svg = drawingSvg(r.value);
  const dxf = drawingDxf(r.value);
  if (!svg.ok) throw svg.error;
  if (!dxf.ok) throw dxf.error;
  return { resolved: r.value, svg: svg.value, dxf: dxf.value };
}

const len = (v: readonly number[]) => Math.hypot(...v);

describe('ExplodeOptions.order', () => {
  it('places step k at k times the distance and leaves unlisted parts at the base', () => {
    const m = explodeMesh(parts(), {
      by: 'tag',
      distance: 0.5,
      order: [['cap'], ['side', 'rear']],
    });
    if (!m.ok) throw m.error;
    const p = Object.fromEntries(m.value.parts.map((x: ExplodedPart) => [x.name, x]));
    expect(p.body?.order).toBe(0);
    expect(len(p.body?.offset ?? [1, 1, 1])).toBe(0);
    expect(p.cap?.order).toBe(1);
    expect(len(p.cap?.offset ?? [])).toBeCloseTo(0.5, 9);
    expect(p.side?.order).toBe(2);
    expect(len(p.side?.offset ?? [])).toBeCloseTo(1, 9);
    expect(p.rear?.order).toBe(2);
  });

  it('keeps the old single-step offset when no order is given', () => {
    const m = explodeMesh(parts(), { by: 'tag', distance: 0.5 });
    if (!m.ok) throw m.error;
    for (const part of m.value.parts) {
      expect(part.order).toBe(0);
      expect(len(part.offset)).toBeCloseTo(0.5, 9);
    }
  });

  it('refuses a part in two steps, an unknown part and a malformed order', () => {
    const twice = explodeMesh(parts(), { by: 'tag', distance: 1, order: [['cap'], ['cap']] });
    expect(twice.ok ? '' : twice.error.code).toBe('model-invalid-argument');
    const missing = explodeMesh(parts(), { by: 'tag', distance: 1, order: [['wing']] });
    expect(missing.ok ? '' : missing.error.code).toBe('model-selection-empty');
    const shape = explodeMesh(parts(), { by: 'tag', distance: 1, order: ['cap'] as never });
    expect(shape.ok ? '' : shape.error.code).toBe('model-invalid-argument');
  });
});

describe('meshViewEdges', () => {
  it('chains the front-facing outline of a box into one closed loop', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const lines = meshViewEdges(m.editMesh, ORTHO_VIEWS.front);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? [];
    expect(line).toHaveLength(5);
    expect(line[0]).toEqual(line[4]);
    const us = line.map((p) => p[0]);
    expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(1, 9);
  });

  it('draws the contour of a corner view and nothing of back faces', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const frame = lookFrame([1, 1, 1]);
    if (frame === undefined) throw new Error('frame');
    const segments = meshViewEdges(m.editMesh, frame).reduce((n, l) => n + l.length - 1, 0);
    expect(segments).toBe(6);
  });

  it('is byte-stable', () => {
    const a = JSON.stringify(meshViewEdges(parts(), ORTHO_VIEWS.right));
    expect(JSON.stringify(meshViewEdges(parts(), ORTHO_VIEWS.right))).toBe(a);
  });
});

describe('explodeDrawing', () => {
  it('adds derived curves, balloons and a bill of materials to an explode view', () => {
    const d = exploded();
    const { resolved } = sheets(d);
    const added = d.items.filter((i: DrawingItem) => i.view === 'ex');
    expect(added.length).toBeGreaterThan(0);
    for (const item of added) {
      expect(item.id.startsWith('ex/')).toBe(true);
      expect(item.basis).toBe('derived');
    }
    const table = added.find((i) => i.kind === 'table');
    if (table?.kind !== 'table') throw new Error('bom');
    expect(table.id).toBe('ex/bom');
    expect(table.columns).toEqual(['item', 'part', 'order', 'faces', 'offset']);
    expect(table.rows.map((r) => r[1])).toEqual(['body', 'cap', 'rear', 'side']);
    expect(table.rows.map((r) => r[0])).toEqual([1, 2, 3, 4]);
    const balloons = added.filter((i) => i.kind === 'note' && i.balloon === true);
    expect(balloons).toHaveLength(4);
    for (const b of balloons) {
      if (b.kind !== 'note') continue;
      expect(table.rows.some((r) => String(r[0]) === b.text)).toBe(true);
      expect(b.at).toBeDefined();
    }
    expect(resolved.views.map((v) => v.id)).toEqual(['tq', 'ex']);
  });

  it('paints parts back to front with a white fill before their outlines', () => {
    const { svg } = sheets(exploded());
    const ids = [...svg.matchAll(/data-id="(ex\/[^"]+\/outline-\d+)"/g)].map((m) => m[1] as string);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(svg).toContain('fill="white"');
    const frame = lookFrame([1, 1, 1]);
    if (frame === undefined) throw new Error('frame');
    const moved = explodeMesh(parts(), {
      by: 'tag',
      distance: 0.6,
      order: [['cap'], ['side', 'rear']],
    });
    if (!moved.ok) throw moved.error;
    const depth = (name: string) => {
      const p = moved.value.parts.find((x: ExplodedPart) => x.name === name) as ExplodedPart;
      return [0, 1, 2].reduce(
        (s, k) =>
          s + ((p.centroid[k] as number) + (p.offset[k] as number)) * (frame.toward[k] as number),
        0,
      );
    };
    const names = ids.map((id) => id.split('/')[1] as string);
    const unique = [...new Set(names)];
    const sorted = [...unique].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1));
    expect(unique).toEqual(sorted);
  });

  it('refuses to run on its own output', () => {
    const once = exploded();
    const again = explodeDrawing(parts(), once);
    expect(again.ok ? '' : again.error.code).toBe('model-invalid-argument');
  });

  it('needs an explode view of an ortho, section or toward view', () => {
    const bad = {
      name: 'bad',
      views: [
        { id: 'front', ortho: 'front' },
        { id: 'd', of: 'front', detail: { box: [0, 0, 1, 1], scale: 200 } },
        { id: 'ex', of: 'd', explode: { by: 'tag', distance: 1 } },
      ],
      items: [],
    } as unknown as Drawing;
    const r = resolveDrawing(bad);
    expect(r.ok ? '' : r.error.code).toBe('model-invalid-argument');
    const both = {
      name: 'bad',
      views: [
        { id: 'front', ortho: 'front' },
        {
          id: 'x',
          of: 'front',
          explode: { by: 'tag', distance: 1 },
          detail: { box: [0, 0, 1, 1], scale: 200 },
        },
      ],
      items: [],
    } as unknown as Drawing;
    const b = resolveDrawing(both);
    expect(b.ok ? '' : b.error.code).toBe('model-invalid-argument');
    const by = resolveDrawing(base({ by: 'colour', distance: 1 }));
    expect(by.ok ? '' : by.error.code).toBe('model-invalid-argument');
    const extra = resolveDrawing(base({ by: 'tag', distance: 1, speed: 2 }));
    expect(extra.ok ? '' : extra.error.code).toBe('model-invalid-argument');
  });

  it('is byte-stable under permuted key order and reruns', () => {
    const a = sheets(exploded());
    const b = sheets(
      exploded(
        base({
          order: [['cap'], ['rear', 'side']],
          distance: 0.6,
          by: 'tag',
        }),
      ),
    );
    expect(sha(a.svg)).toBe(sha(sheets(exploded()).svg));
    expect(sha(a.dxf)).toBe(sha(sheets(exploded()).dxf));
    expect(sha(b.svg)).toBe(sha(a.svg));
    expect(sha(b.dxf)).toBe(sha(a.dxf));
  });

  it('matches the golden sheet', () => {
    const { svg, dxf } = sheets(exploded());
    expect({ svg: sha(svg), dxf: sha(dxf) }).toEqual({
      svg: 'df7a1ba121711a5936d185fe79359d6f5fe91cdd9ac4e125df49cac0fa2b437b',
      dxf: '02e9068c456f60992a1537c61b0b9016cfee1c96d803f1ccd73f66913be121c5',
    });
  });

  it('leaves validate({ drawing }) quiet about derived views', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'body' });
    m.box({ size: [0.3, 0.3, 0.3], center: [0, 0.8, 0], tag: 'cap' });
    const d = exploded();
    expect(m.drawing(d).status).toBe('ok');
    const report = m.validate({ drawing: true }).issues.filter((i) => i.code === 'drawing');
    expect(report).toEqual([]);
  });
});
