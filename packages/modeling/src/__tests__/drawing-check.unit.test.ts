import { describe, expect, it } from 'vitest';
import { type Drawing, type DrawingItem, maskIoU, model, silhouetteIoU } from '../index';

const square = (h: number, du = 0): [number, number][] => [
  [-h + du, -h],
  [h + du, -h],
  [h + du, h],
  [-h + du, h],
];

function boxModel() {
  const m = model();
  m.box({ size: [1, 1, 1] });
  // The box's top edge along z on the +x side, seen as a horizontal line in the right view.
  m.featureLine({
    name: 'edge',
    curve: {
      degree: 1,
      points: [
        [0.5, 0.5, -0.5],
        [0.5, 0.5, 0.5],
      ],
      knots: [0, 0, 1, 1],
    },
  });
  return m;
}

const views: Drawing['views'] = [
  { id: 'front', ortho: 'front' },
  { id: 'side', ortho: 'right' },
  { id: 'z0', section: { axis: 'z', at: 0 } },
];

function drawing(items: DrawingItem[]): Drawing {
  return { name: 'box sheet', views, items };
}

function findings(items: DrawingItem[]) {
  const m = boxModel();
  expect(m.drawing(drawing(items)).status).toBe('ok');
  return m
    .validate({ drawing: true })
    .issues.filter((i) => i.code === 'drawing')
    .map((i) => i.detail);
}

describe('validate({ drawing })', () => {
  it('maskIoU counts overlap and each side alone', () => {
    const a = new Uint8Array([1, 1, 0, 0]);
    const b = new Uint8Array([0, 1, 1, 0]);
    const r = maskIoU(a, b);
    expect(r.ok && r.value).toEqual({ iou: 1 / 3, onlyA: 1, onlyB: 1 });
    expect(
      maskIoU(new Uint8Array(2), new Uint8Array(2)).ok &&
        maskIoU(new Uint8Array(2), new Uint8Array(2)),
    ).toMatchObject({ value: { iou: 1 } });
    expect(maskIoU(a, new Uint8Array(3)).ok).toBe(false);
  });

  it('silhouetteIoU rasterises a session or its snapshot against a drawn outline', () => {
    const m = boxModel();
    const fit = silhouetteIoU(m, 'front', square(0.5), 0.005);
    const big = silhouetteIoU(m.snapshot(), 'front', square(0.6), 0.005);
    if (!fit.ok || !big.ok) throw new Error('iou');
    expect(fit.value.iou).toBeGreaterThan(0.98);
    expect(big.value.iou).toBeCloseTo(1 / 1.44, 2);
    expect(big.value.onlyB).toBe(0);
  });

  it('passes a drawing that matches the state', () => {
    expect(
      findings([
        {
          id: 'outline',
          view: 'front',
          role: 'silhouette',
          kind: 'curve',
          closed: true,
          curve: { kind: 'polyline', points: square(0.5) },
          tolerance: 0.005,
        },
        {
          id: 'cut',
          view: 'z0',
          role: 'section',
          kind: 'curve',
          closed: true,
          curve: { kind: 'polyline', points: square(0.5) },
        },
        {
          id: 'edge@side',
          view: 'side',
          role: 'feature',
          link: 'edge',
          kind: 'curve',
          curve: {
            kind: 'polyline',
            points: [
              [0.5, 0.5],
              [-0.5, 0.5],
            ],
          },
        },
        { id: 'a', view: 'side', role: 'package', kind: 'point', at: [-0.5, 0] },
        { id: 'b', view: 'side', role: 'package', kind: 'point', at: [0.5, 0] },
        {
          id: 'length',
          view: 'side',
          role: 'package',
          kind: 'dimension',
          measure: 'distance',
          refs: ['a', 'b'],
          value: 1,
        },
      ]),
    ).toEqual([]);
  });

  it('reports each check that a drawing falsifies', () => {
    const got = findings([
      {
        id: 'outline',
        view: 'front',
        role: 'silhouette',
        kind: 'curve',
        closed: true,
        curve: { kind: 'polyline', points: square(0.65) },
      },
      {
        id: 'cut',
        view: 'z0',
        role: 'section',
        kind: 'curve',
        closed: true,
        curve: { kind: 'polyline', points: square(0.5, 0.005) },
      },
      {
        id: 'edge@side',
        view: 'side',
        role: 'feature',
        link: 'edge',
        kind: 'curve',
        curve: {
          kind: 'polyline',
          points: [
            [0.5, 0.505],
            [-0.5, 0.505],
          ],
        },
      },
      {
        id: 'lost@side',
        view: 'side',
        role: 'feature',
        link: 'missing',
        kind: 'curve',
        curve: {
          kind: 'polyline',
          points: [
            [0, 0],
            [0.1, 0],
          ],
        },
      },
      { id: 'a', view: 'side', role: 'package', kind: 'point', at: [-0.5, 0] },
      { id: 'b', view: 'side', role: 'package', kind: 'point', at: [0.5, 0] },
      {
        id: 'length',
        view: 'side',
        role: 'package',
        kind: 'dimension',
        measure: 'distance',
        refs: ['a', 'b'],
        value: 1.1,
      },
    ]);
    const by = (item: string) => got.find((d) => d.item === item);
    expect(by('outline')).toMatchObject({ check: 'silhouette' });
    expect(by('outline')?.iou as number).toBeLessThan(0.93);
    expect(by('cut')).toMatchObject({ check: 'section' });
    expect(by('cut')?.max as number).toBeCloseTo(0.005, 3);
    expect(by('edge@side')).toMatchObject({ check: 'feature' });
    expect(by('edge@side')?.max as number).toBeCloseTo(0.005, 4);
    expect(by('lost@side')).toEqual({
      check: 'feature',
      drawing: 'box sheet',
      item: 'lost@side',
      view: 'side',
      tolerance: 0.002,
    });
    expect(by('length')).toMatchObject({ check: 'dimension', value: 1.1 });
    expect(by('length')?.measured as number).toBeCloseTo(1, 12);
    expect(got.length).toBe(5);
  });

  it('compares a feature line over the span it shares with the drawing', () => {
    // Drawn 10 cm past each end of the 3D line: a declared inset passes, an undeclared one fails coverage.
    const long = (inset?: number) =>
      findings([
        {
          id: 'edge@side',
          view: 'side',
          role: 'feature',
          link: 'edge',
          kind: 'curve',
          curve: {
            kind: 'polyline',
            points: [
              [0.6, 0.5],
              [-0.6, 0.5],
            ],
          },
          ...(inset === undefined ? {} : { inset }),
        },
      ]);
    expect(long(0.1)).toEqual([]);
    expect(long()[0]?.coverage as number).toBeCloseTo(1 / 1.2, 1);
  });

  it('guards the shared span with coverage, and takes designed insets explicitly', () => {
    const run = (z0: number, z1: number, item: Partial<DrawingItem> = {}) => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      m.featureLine({
        name: 'edge',
        curve: {
          degree: 1,
          points: [
            [0.5, 0.5, z0],
            [0.5, 0.5, z1],
          ],
          knots: [0, 0, 1, 1],
        },
      });
      m.drawing(
        drawing([
          {
            id: 'edge@side',
            view: 'side',
            role: 'feature',
            link: 'edge',
            kind: 'curve',
            curve: {
              kind: 'polyline',
              points: [
                [0.5, 0.5],
                [-0.5, 0.5],
              ],
            },
            ...item,
          } as DrawingItem,
        ]),
      );
      return m
        .validate({ drawing: true })
        .issues.filter((i) => i.code === 'drawing')
        .map((i) => i.detail);
    };
    // The 3D line stops 20 % short: it lies on the drawing where it exists, but coverage fails.
    const short = run(-0.5, 0.3);
    expect(short[0]).toMatchObject({ check: 'feature', item: 'edge@side' });
    expect(short[0]?.coverage as number).toBeCloseTo(0.8, 1);
    // Inset 5 mm at each end of a 1 m line passes when the drawing declares it (inset 6 mm).
    expect(run(-0.495, 0.495, { inset: 0.006 } as Partial<DrawingItem>)).toEqual([]);
  });

  it('measures a 3-point angle at its vertex, and fails it rotated 2 degrees at a 1 degree tolerance', () => {
    const deg = Math.PI / 180;
    const angle = (rotate: number): DrawingItem[] => [
      { id: 'G1', view: 'side', role: 'pivot', kind: 'point', at: [0.5, 0] },
      { id: 'M2', view: 'side', role: 'pivot', kind: 'point', at: [0, 0] },
      {
        id: 'G2',
        view: 'side',
        role: 'pivot',
        kind: 'point',
        at: [Math.cos(60 * deg + rotate), Math.sin(60 * deg + rotate)],
      },
      {
        id: 'mu',
        view: 'side',
        role: 'linkage',
        kind: 'dimension',
        measure: 'angle',
        refs: ['G1', 'M2', 'G2'],
        value: 60 * deg,
        tolerance: deg,
      },
    ];
    expect(findings(angle(0))).toEqual([]);
    const off = findings(angle(2 * deg));
    expect(off[0]).toMatchObject({ check: 'dimension', item: 'mu' });
    expect(off[0]?.measured as number).toBeCloseTo(62 * deg, 9);
  });

  it('counts a cut only against the drawn piece whose span it falls in', () => {
    // Only the top half of the section is drawn: the cut's lower half answers to no piece.
    const top: [number, number][] = [
      [0.5, 0],
      [0.5, 0.5],
      [-0.5, 0.5],
      [-0.5, 0],
    ];
    expect(
      findings([
        {
          id: 'half',
          view: 'z0',
          role: 'section',
          kind: 'curve',
          curve: { kind: 'polyline', points: top },
        },
      ]),
    ).toEqual([]);
  });
});
