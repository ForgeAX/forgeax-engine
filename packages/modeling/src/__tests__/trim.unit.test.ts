import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';
import {
  bakeTrimSheet,
  type TrimModule,
  type TrimRegion,
  type TrimSheet,
  type TrimSheetOptions,
  trimSheet,
} from '../trim';

type V3 = [number, number, number];

function sheetOf(options: TrimSheetOptions): TrimSheet {
  const r = trimSheet(options);
  if (!r.ok) throw r.error;
  return r.value;
}

function info(report: OpReport): {
  metrics: Record<string, number>;
  instances: Record<string, number>[];
} {
  const d = report.diagnostics?.find((x) => x.severity === 'info');
  if (d === undefined) throw new Error(`${report.op}: ${report.error?.message}`);
  return d.detail as { metrics: Record<string, number>; instances: Record<string, number>[] };
}

const warnings = (report: OpReport) =>
  (report.diagnostics ?? []).filter((d) => d.severity === 'warn').map((d) => d.message);

function uvs(m: Model, faces = sel.all()): [number, number][] {
  const mesh = m.editMesh;
  return faces
    .evaluate(mesh)
    .flatMap((f) =>
      mesh.faceHalves(f).map((h) => Array.from(mesh.corner('uv0', h) ?? []) as [number, number]),
    );
}

/** The C-400 pilot regions (tiangong kitWall trim, 1024 texels at 320 px/m). */
const PILOT: TrimModule[] = [
  { id: 'fan', size: [1.96, 1.96] },
  { id: 'louvre', size: [1.2, 0.96] },
  { id: 'mullion', size: [0.5, 1.3] },
  { id: 'recess', size: [0.1, 0.1] },
  { id: 'bolt', size: [0.13, 0.13] },
  { id: 'rib', size: [0.1, 0.35] },
  { id: 'clamp', size: [0.72, 0.12] },
];

/** Contents never overlap and keep the padding apart; every content lies in the sheet. */
function expectSeparated(sheet: TrimSheet): void {
  const rects = Object.values(sheet.regions).map((r) => r.rect);
  for (const [x, y, w, h] of rects) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(sheet.size);
    expect(y + h).toBeLessThanOrEqual(sheet.size);
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [ax, ay, aw, ah] = rects[i] as readonly number[] as [number, number, number, number];
      const [bx, by, bw, bh] = rects[j] as readonly number[] as [number, number, number, number];
      const gapX = Math.max(bx - (ax + aw), ax - (bx + bw));
      const gapY = Math.max(by - (ay + ah), ay - (by + bh));
      expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(sheet.padding);
    }
  }
}

describe('trimSheet layout', () => {
  it('reproduces the C-400 pilot sheet (56.5 % used); fill raises it to 65 % uniform, 74 % with one scale bucket', () => {
    const pilot = sheetOf({
      key: 'kitwall',
      size: 1024,
      density: 320,
      padding: 8,
      inset: 0,
      modules: PILOT,
    });
    expectSeparated(pilot);
    expect(pilot.regions.fan?.rect.slice(2)).toEqual([627, 627]);
    expect(pilot.regions.bolt?.rect.slice(2)).toEqual([42, 42]);
    expect(pilot.metrics.utilization).toBeCloseTo(0.5656, 3);
    expect(pilot.metrics.fillScale).toBe(1);
    const uniform = sheetOf({
      key: 'kitwall',
      size: 1024,
      density: 320,
      padding: 8,
      inset: 0,
      modules: PILOT,
      fill: true,
    });
    expectSeparated(uniform);
    // The fan and louvre stacked fill the height: a uniform fill stops at 1.078.
    expect(uniform.metrics.fillScale).toBeGreaterThan(1.07);
    expect(uniform.metrics.utilization).toBeGreaterThanOrEqual(0.65);
    expect(uniform.metrics.densitySpread).toBeLessThan(0.01);
    const grown = sheetOf({
      key: 'kitwall',
      size: 1024,
      density: 320,
      padding: 8,
      inset: 0,
      modules: PILOT,
      fill: { grow: Math.SQRT2 },
    });
    expectSeparated(grown);
    expect(grown.metrics.utilization).toBeGreaterThanOrEqual(0.74);
    const densities = Object.values(grown.regions).flatMap((r) => r.density);
    expect(Math.max(...densities) / Math.min(...densities)).toBeLessThanOrEqual(Math.SQRT2 * 1.02);
    expect(Math.min(...densities)).toBeGreaterThanOrEqual(320 * uniform.metrics.fillScale * 0.99);
    const again = sheetOf({
      key: 'kitwall',
      size: 1024,
      density: 320,
      padding: 8,
      inset: 0,
      modules: PILOT,
      fill: { grow: Math.SQRT2 },
    });
    expect(again.regions).toEqual(grown.regions);
    expect(
      trimSheet({ key: 'k', size: 1024, density: 320, modules: PILOT, fill: { grow: 3 } }).ok,
    ).toBe(false);
  });

  it('places strips across the width top-down in declaration order, cells below', () => {
    const sheet = sheetOf({
      key: 's',
      size: 256,
      density: 128,
      padding: 4,
      inset: 0,
      modules: [
        { id: 'thin', size: [2, 0.125], tiling: 'u', period: 0.5 },
        { id: 'thick', size: [2, 0.25], tiling: 'u' },
        { id: 'cell', size: [0.5, 0.5] },
      ],
    });
    expectSeparated(sheet);
    expect(sheet.regions.thin?.rect).toEqual([0, 2, 256, 16]);
    expect(sheet.regions.thin?.uv).toEqual([0, 2 / 256, 1, 18 / 256]);
    expect(sheet.regions.thin?.density).toEqual([128, 128]);
    expect(sheet.regions.thick?.rect).toEqual([0, 22, 256, 32]);
    expect(sheet.regions.cell?.rect[1]).toBeGreaterThan(54);
    expect(sheet.metrics.strips).toBe(2);
    // The default inset (0.5 texel) borders the content, which keeps its density.
    const inset = sheetOf({
      key: 's',
      size: 256,
      density: 128,
      padding: { mips: 1 },
      modules: [
        { id: 'thin', size: [2, 0.125], tiling: 'u' },
        { id: 'cell', size: [0.25, 0.25] },
      ],
    });
    expect(inset.padding).toBe(4);
    expect(inset.regions.thin?.rect.slice(2)).toEqual([256, 17]);
    expect(inset.regions.thin?.density).toEqual([128, 128]);
    expect(inset.regions.cell?.rect.slice(2)).toEqual([33, 33]);
    expect(inset.regions.cell?.density).toEqual([128, 128]);
    // The default padding protects down to the 128-texel level, as bake gutters do.
    expect(
      sheetOf({ key: 's', size: 1024, density: 128, modules: [{ id: 'a', size: [1, 1] }] }).padding,
    ).toBe(16);
  });

  it('keeps fixed rects (a standardized layout) and packs auto cells around them', () => {
    const sheet = sheetOf({
      key: 's',
      size: 128,
      density: 100,
      padding: 4,
      modules: [
        { id: 'fixed', size: [0.4, 0.4], rect: [60, 60, 40, 40] },
        { id: 'a', size: [0.5, 0.5] },
        { id: 'b', size: [0.3, 0.3] },
      ],
    });
    expect(sheet.regions.fixed?.rect).toEqual([60, 60, 40, 40]);
    expectSeparated(sheet);
  });

  it('rejects a period that does not divide the strip length (BK3 falsifier) and other bad input', () => {
    const strip = (period: number) =>
      trimSheet({
        key: 's',
        size: 64,
        density: 64,
        modules: [{ id: 'l', size: [1, 0.25], tiling: 'u', period }],
      });
    expect(strip(0.25).ok).toBe(true);
    const bad = strip(0.3);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('model-invalid-argument');
      expect(bad.error.detail?.repeats).toBeCloseTo(3.333, 3);
    }
    const codes = (o: Partial<TrimSheetOptions>) => {
      const r = trimSheet({
        key: 's',
        size: 64,
        density: 64,
        modules: [{ id: 'a', size: [0.25, 0.25] }],
        ...o,
      });
      return r.ok ? 'ok' : r.error.code;
    };
    expect(codes({})).toBe('ok');
    expect(codes({ key: 'a b' })).toBe('model-invalid-argument');
    expect(codes({ size: 10 })).toBe('model-invalid-argument');
    expect(codes({ density: 0 })).toBe('model-invalid-argument');
    expect(codes({ padding: 3 })).toBe('model-invalid-argument');
    expect(codes({ block: 5 })).toBe('model-invalid-argument');
    expect(codes({ modules: [] })).toBe('model-invalid-argument');
    expect(
      codes({
        modules: [
          { id: 'a', size: [0.25, 0.25] },
          { id: 'a', size: [0.25, 0.25] },
        ],
      }),
    ).toBe('model-invalid-argument');
    expect(codes({ modules: [{ id: 'a', size: [0.25, -1] }] })).toBe('model-invalid-argument');
    expect(codes({ modules: [{ id: 'a', size: [1, 0.25], tiling: 'u', density: 32 }] })).toBe(
      'model-invalid-argument',
    );
    expect(codes({ modules: [{ id: 'a', size: [0.25, 0.25], rect: [60, 60, 10, 10] }] })).toBe(
      'model-invalid-argument',
    );
    expect(codes({ modules: [{ id: 'a', size: [2, 2] }] })).toBe('model-precondition');
  });
});

/** A module-size quad in the plane through `origin` spanned by unit s and t (normal s x t). */
function quad(m: Model, origin: V3, s: V3, t: V3, size: [number, number], tag: string): void {
  const at = (a: number, b: number): V3 => [
    origin[0] + s[0] * a + t[0] * b,
    origin[1] + s[1] * a + t[1] * b,
    origin[2] + s[2] * a + t[2] * b,
  ];
  m.polygon({ points: [at(0, 0), at(size[0], 0), at(size[0], size[1]), at(0, size[1])], tag });
}

describe('uv.trim', () => {
  const sheet = sheetOf({
    key: 'kit',
    size: 512,
    density: 256,
    padding: 8,
    modules: [
      { id: 'louvre', size: [1, 0.25], tiling: 'u', period: 0.25 },
      { id: 'bolt', size: [0.125, 0.125] },
      { id: 'panel', size: [0.5, 0.25] },
    ],
  });
  const bolt = sheet.regions.bolt as TrimRegion;

  it('maps module-size quads exactly onto the region, whatever their placement (stacked instances)', () => {
    const m = model();
    const placements: [V3, V3, V3][] = [
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [3, 1, 2],
        [0, 0, -1],
        [0, 1, 0],
      ],
      [
        [-2, 4, 1],
        [0.6, 0.8, 0],
        [0, 0, 1],
      ],
      [
        [5, -1, 0],
        [-1, 0, 0],
        [0, -1, 0],
      ],
    ];
    for (const [i, [o, s, t]] of placements.entries()) quad(m, o, s, t, [0.125, 0.125], `bolt${i}`);
    const r = m.uv.trim({ faces: sel.all(), region: bolt });
    expect(r.status).toBe('ok');
    expect(r.roles).toEqual({ trimmed: 4 });
    expect(warnings(r)).toEqual([]);
    const { metrics } = info(r);
    expect(metrics.instances).toBe(4);
    expect(metrics.densityDeviation).toBeLessThan(1e-9);
    expect(metrics.projectionError).toBeLessThan(1e-6);
    const [x, y, w, h] = bolt.rect;
    const [u0, v0, u1, v1] = [
      (x + 0.5) / 512,
      (y + 0.5) / 512,
      (x + w - 0.5) / 512,
      (y + h - 0.5) / 512,
    ];
    for (const [u, v] of uvs(m)) {
      // Region mapping exactness: every corner on a corner of the region inside its inset.
      expect(Math.min(Math.abs(u - u0), Math.abs(u - u1))).toBeLessThan(1e-6);
      expect(Math.min(Math.abs(v - v0), Math.abs(v - v1))).toBeLessThan(1e-6);
    }
  });

  it('tiles along a strip in meters and keeps v in the strip band; world anchoring continues across instances', () => {
    const m = model();
    quad(m, [0, 0, 0], [0, 1, 0], [1, 0, 0], [3.5, 0.25], 'a');
    const r = m.uv.trim({
      faces: sel.tag('a'),
      region: sheet.regions.louvre as TrimRegion,
      axis: [0, 1, 0],
    });
    expect(r.status).toBe('ok');
    const louvre = sheet.regions.louvre as TrimRegion;
    const us = uvs(m).map((p) => p[0]);
    const vs = uvs(m).map((p) => p[1]);
    expect(Math.min(...us)).toBeCloseTo(0, 9);
    expect(Math.max(...us)).toBeCloseTo(3.5, 6);
    for (const v of vs) expect(v).toBeGreaterThanOrEqual(louvre.uv[1] - 1e-9);
    for (const v of vs) expect(v).toBeLessThanOrEqual(louvre.uv[3] + 1e-9);
    expect(info(r).metrics.densityDeviation).toBeLessThan(1e-9);
    const w = model();
    quad(w, [0, 0, 0], [1, 0, 0], [0, 1, 0], [1.3, 0.25], 'a');
    quad(w, [1.3, 0, 0], [1, 0, 0], [0, 1, 0], [0.7, 0.25], 'b');
    w.uv.trim({ faces: sel.all(), region: louvre, axis: [1, 0, 0], anchor: 'world' });
    const second = uvs(w, sel.tag('b')).map((p) => p[0]);
    expect(Math.min(...second)).toBeCloseTo(1.3, 6);
  });

  it('reports stretch above 10 % of the region density (fit) and the metric overflow precondition', () => {
    const m = model();
    quad(m, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0.25, 0.25], 'big');
    const fitted = m.uv.trim({ faces: sel.all(), region: bolt, fit: { u: 'fit', v: 'fit' } });
    expect(fitted.status).toBe('ok');
    expect(info(fitted).metrics.densityDeviation).toBeCloseTo(0.5, 9);
    expect(warnings(fitted).join()).toMatch(/deviate more than 10%/);
    const near = model();
    quad(near, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0.13, 0.12], 'near');
    const close = near.uv.trim({ faces: sel.all(), region: bolt, fit: { u: 'fit', v: 'fit' } });
    expect(info(close).metrics.densityDeviation).toBeLessThan(0.1);
    expect(warnings(close)).toEqual([]);
    const over = model();
    quad(over, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0.25, 0.25], 'big');
    expect(over.uv.trim({ faces: sel.all(), region: bolt }).status).toBe('failed');
    expect(over.poisoned?.code).toBe('model-precondition');
  });

  it('splits instances at hard edges, warns about non-planar runs and rejects bad options', () => {
    const box = model();
    box.box({ size: [0.125, 0.125, 0.125] });
    const r = box.uv.trim({ faces: sel.all(), region: bolt });
    expect(r.status).toBe('ok');
    expect(info(r).metrics.instances).toBe(6);
    expect(warnings(r)).toEqual([]);
    const bent = model();
    quad(bent, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0.06, 0.12], 'a');
    quad(bent, [0.06, 0, 0], [0.5, 0, -Math.sqrt(0.75)], [0, 1, 0], [0.06, 0.12], 'b');
    bent.weld({ distance: 1e-6 });
    const folded = bent.uv.trim({ faces: sel.all(), region: bolt, split: 90 });
    expect(info(folded).metrics.instances).toBe(1);
    expect(warnings(folded).join()).toMatch(/not planar/);
    const fail = (options: Record<string, unknown>) => {
      const m = model();
      quad(m, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0.1, 0.1], 'a');
      m.uv.trim({ faces: sel.all(), region: bolt, ...options });
      return m.poisoned?.code;
    };
    expect(fail({})).toBeUndefined();
    expect(fail({ fit: { u: 'tile' } })).toBe('model-invalid-argument');
    expect(fail({ axis: [0, 0, 1] })).toBe('model-invalid-argument');
    expect(fail({ axis: 'up' })).toBe('model-invalid-argument');
    expect(fail({ offset: [Number.NaN, 0] })).toBe('model-invalid-argument');
    expect(fail({ anchor: 'sheet' })).toBe('model-invalid-argument');
    expect(fail({ split: -1 })).toBe('model-invalid-argument');
    expect(fail({ region: { id: 'x' } })).toBe('model-invalid-argument');
  });

  it('uv.swatch maps every face inside the region interior', () => {
    const m = model();
    m.box({ size: [1, 2, 3] });
    const panel = sheet.regions.panel as TrimRegion;
    const r = m.uv.swatch({ faces: sel.all(), region: panel });
    expect(r.status).toBe('ok');
    expect(r.roles).toEqual({ swatched: 6 });
    expect(warnings(r)).toEqual([]);
    const [x, y, w, h] = panel.rect;
    for (const [u, v] of uvs(m)) {
      // Every texel a bilinear tap reads lies in the region: the face samples one color.
      expect(u * 512).toBeGreaterThanOrEqual(x + 0.5 - 1e-6);
      expect(u * 512).toBeLessThanOrEqual(x + w - 0.5 + 1e-6);
      expect(v * 512).toBeGreaterThanOrEqual(y + 0.5 - 1e-6);
      expect(v * 512).toBeLessThanOrEqual(y + h - 0.5 + 1e-6);
    }
    const bad = model();
    bad.box({ size: [1, 1, 1] });
    bad.uv.swatch({ faces: sel.all(), region: { ...panel, inset: -1 } });
    expect(bad.poisoned?.code).toBe('model-invalid-argument');
  });
});

// ---- bake --------------------------------------------------------------------------

const texel = (t: TextureAsset, x: number, y: number): V3 => {
  const size = t.shape.extent.width;
  const d = t.data as Uint8Array;
  const o = (y * size + x) * 4;
  return [
    ((d[o] as number) / 255) * 2 - 1,
    ((d[o + 1] as number) / 255) * 2 - 1,
    ((d[o + 2] as number) / 255) * 2 - 1,
  ];
};
const angle = (a: V3, b: V3) => {
  const la = Math.hypot(...a);
  const lb = Math.hypot(...b);
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
};
const p95 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.95)] as number;
};

/**
 * Seam error of a strip normal map: per row, the angle across the wrap (last column ->
 * first) minus the angle across the same-phase interior pair one period earlier.
 */
function seamError(t: TextureAsset, region: TrimRegion, periodTexels: number): number {
  const [x0, y0, w, h] = region.rect;
  let worst = 0;
  for (let j = y0; j < y0 + h; j++) {
    const wrap = angle(texel(t, x0 + w - 1, j), texel(t, x0, j));
    const k = x0 + w - periodTexels;
    const interior = angle(texel(t, k - 1, j), texel(t, k, j));
    worst = Math.max(worst, Math.abs(wrap - interior));
  }
  return worst;
}

const A = 0.01;
const L = 0.5;
/** A wavy height field: periodic along s with period L / 4, and gently along t. */
const wave = (s: number, t: number) =>
  A * Math.sin((8 * Math.PI * s) / L) + 0.5 * A * Math.sin(2 * Math.PI * t * 4);

describe('bakeTrimSheet', () => {
  it('stamps an analytic strip whose normals match the field and tile across the wrap', () => {
    const sheet = sheetOf({
      key: 'wave',
      size: 128,
      density: 256,
      padding: 4,
      modules: [
        {
          id: 'w',
          size: [L, 0.125],
          tiling: 'u',
          period: L / 4,
          source: { kind: 'analytic', height: wave },
        },
      ],
    });
    const baked = bakeTrimSheet(sheet, {
      maps: ['normal', 'height', 'ao', 'curvature', 'materialId'],
      samples: 4,
    });
    if (!baked.ok) throw baked.error;
    const region = sheet.regions.w as TrimRegion;
    const normal = baked.value.textures.normal as TextureAsset;
    const [x0, y0, w, h] = region.rect;
    const errors: number[] = [];
    for (let j = y0; j < y0 + h; j++) {
      for (let i = x0; i < x0 + w; i++) {
        const s = ((i - x0 + 0.5) / w) * L;
        const t = ((j - y0 + 0.5) / h) * 0.125;
        const e = 1e-6;
        const gx = (wave(s + e, t) - wave(s - e, t)) / (2 * e);
        const gy = (wave(s, t + e) - wave(s, t - e)) / (2 * e);
        errors.push(angle(texel(normal, i, j), [-gx, -gy, 1]));
      }
    }
    expect(p95(errors)).toBeLessThan(1.5);
    expect(seamError(normal, region, w / 4)).toBeLessThanOrEqual(1);
    expect(baked.value.materials.map((m) => m.slot)).toEqual(['trim-base']);
    expect(baked.value.report.sources).toEqual({ w: 'analytic' });
    expect(baked.value.report.cage.offset).toBeCloseTo(1.25 * 1.5 * A, 3);
    expect(baked.value.report.heightRange).toBe(baked.value.report.cage.offset);
    const again = bakeTrimSheet(sheet, {
      maps: ['normal', 'height', 'ao', 'curvature', 'materialId'],
      samples: 4,
    });
    if (!again.ok) throw again.error;
    for (const map of ['normal', 'height', 'ao', 'curvature', 'materialId'] as const) {
      expect(again.value.textures[map]?.data).toEqual(baked.value.textures[map]?.data);
    }
  });

  const P = L / 4;
  const HW = 0.2 * P;
  const PEAK = 0.01;
  /** Tent ridges (half width HW, height PEAK) at k P + 0.9 P as two sloped quads each, running along x or y. */
  function ridges(count: number, along: 'x' | 'y', extent: number): Model {
    const m = model();
    const ln = Math.hypot(HW, PEAK);
    for (let k = -1; k <= count; k++) {
      const c = k * P + 0.9 * P;
      if (along === 'y') {
        quad(
          m,
          [c - HW, -0.01, 0],
          [HW / ln, 0, PEAK / ln],
          [0, 1, 0],
          [ln, extent + 0.02],
          `r${k}a`,
        );
        quad(
          m,
          [c, -0.01, PEAK],
          [HW / ln, 0, -PEAK / ln],
          [0, 1, 0],
          [ln, extent + 0.02],
          `r${k}b`,
        );
      } else {
        quad(
          m,
          [-0.01, c - HW, 0],
          [1, 0, 0],
          [0, HW / ln, PEAK / ln],
          [extent + 0.02, ln],
          `r${k}a`,
        );
        quad(
          m,
          [-0.01, c, PEAK],
          [1, 0, 0],
          [0, HW / ln, -PEAK / ln],
          [extent + 0.02, ln],
          `r${k}b`,
        );
      }
    }
    return m;
  }

  it('bakes a mesh strip that tiles across the wrap; the same detail as a cell does not (falsifier)', () => {
    // Ridges inside [0, L) only: the strip's wrap copies supply the ridge crossing s = 0.
    const detail = ridges(4, 'y', 0.125);
    for (const k of ['-1', '4']) detail.delete(sel.tag(`r${k}a`).or(sel.tag(`r${k}b`)));
    const modules = (tiling: 'u' | 'none'): TrimModule[] => [
      {
        id: 'w',
        size: [L, 0.125],
        tiling,
        ...(tiling === 'u' ? { period: P } : { density: 256 }),
        source: { kind: 'mesh', detail },
      },
    ];
    const strip = sheetOf({
      key: 'ridge',
      size: 128,
      density: 256,
      padding: 4,
      modules: modules('u'),
    });
    const settings = {
      maps: ['normal'] as const,
      samples: 4 as const,
      detailNormals: { mode: 'flat' as const },
      ao: { rays: 8 },
    };
    const tiled = bakeTrimSheet(strip, settings);
    if (!tiled.ok) throw tiled.error;
    const region = strip.regions.w as TrimRegion;
    expect(
      seamError(tiled.value.textures.normal as TextureAsset, region, region.rect[2] / 4),
    ).toBeLessThanOrEqual(1);
    const cell = sheetOf({
      key: 'ridge',
      size: 256,
      density: 256,
      padding: 4,
      modules: modules('none'),
    });
    const flat = bakeTrimSheet(cell, settings);
    if (!flat.ok) throw flat.error;
    const cellRegion = cell.regions.w as TrimRegion;
    expect(
      seamError(flat.value.textures.normal as TextureAsset, cellRegion, cellRegion.rect[2] / 4),
    ).toBeGreaterThan(5);
  });

  /** A height field mesh over [0, w] x [0, h] in module space. */
  function heightField(w: number, h: number, f: (s: number, t: number) => number): Model {
    const m = model();
    m.plane({
      width: w,
      height: h,
      widthSegments: Math.round(w * 128),
      heightSegments: Math.round(h * 128),
      center: [w / 2, h / 2, 0],
    });
    const mesh = m.editMesh;
    for (const v of mesh.vertices()) {
      const [x, y] = mesh.position(v);
      mesh.setPosition(v, x as number, y as number, f(x as number, y as number));
    }
    return m;
  }
  const along = (s: number) => 0.012 * (1 - Math.cos((2 * Math.PI * s) / P));
  const across = (s: number, t: number) => along(t) + 0.002 * Math.sin((2 * Math.PI * s) / 0.25);

  it('mesh and analytic sources of one relief agree in tangent space (both axes) and AO', () => {
    const modules = (mesh: boolean): TrimModule[] => [
      {
        id: 'sx',
        size: [L, 0.125],
        tiling: 'u',
        source: mesh
          ? { kind: 'mesh', detail: heightField(L, 0.125, along) }
          : { kind: 'analytic', height: along },
      },
      {
        id: 'ty',
        size: [0.25, L],
        source: mesh
          ? { kind: 'mesh', detail: heightField(0.25, L, across) }
          : { kind: 'analytic', height: across },
      },
    ];
    const settings = {
      maps: ['normal', 'ao', 'height'] as const,
      cage: { offset: 0.03 },
      samples: 4 as const,
      detailNormals: { mode: 'smooth' as const },
      ao: { rays: 32 },
    };
    const meshSheet = sheetOf({
      key: 'm',
      size: 128,
      density: 128,
      padding: 4,
      modules: modules(true),
    });
    const fieldSheet = sheetOf({
      key: 'f',
      size: 128,
      density: 128,
      padding: 4,
      modules: modules(false),
    });
    const rects = (sheet: TrimSheet) => Object.values(sheet.regions).map((r) => [r.id, r.rect]);
    expect(rects(fieldSheet)).toEqual(rects(meshSheet));
    const a = bakeTrimSheet(meshSheet, settings);
    const b = bakeTrimSheet(fieldSheet, settings);
    if (!a.ok) throw a.error;
    if (!b.ok) throw b.error;
    expect(a.value.report.bake?.metrics.rayHitRatio).toBe(1);
    for (const region of Object.values(meshSheet.regions)) {
      const [x0, y0, w, h] = region.rect;
      const errors: number[] = [];
      let aoGap = 0;
      let heightGap = 0;
      let darkest = 1;
      const ao = (t: TextureAsset, i: number, j: number) =>
        (t.data as Uint8Array)[(j * 128 + i) * 4] as number;
      for (let j = y0; j < y0 + h; j++) {
        for (let i = x0; i < x0 + w; i++) {
          errors.push(
            angle(
              texel(a.value.textures.normal as TextureAsset, i, j),
              texel(b.value.textures.normal as TextureAsset, i, j),
            ),
          );
          darkest = Math.min(darkest, ao(a.value.textures.ao as TextureAsset, i, j) / 255);
          aoGap +=
            Math.abs(
              ao(a.value.textures.ao as TextureAsset, i, j) -
                ao(b.value.textures.ao as TextureAsset, i, j),
            ) / 255;
          heightGap +=
            Math.abs(
              ao(a.value.textures.height as TextureAsset, i, j) -
                ao(b.value.textures.height as TextureAsset, i, j),
            ) / 255;
        }
      }
      expect(p95(errors)).toBeLessThan(3);
      // The valleys are occluded (not a vacuous AO comparison), and both AO estimators agree.
      expect(darkest).toBeLessThan(0.96);
      expect(aoGap / (w * h)).toBeLessThan(0.05);
      expect(heightGap / (w * h)).toBeLessThan(0.01);
    }
  }, 30_000);

  it('pads every region with its own edge texels, composites material ids and stores textures', () => {
    const detail = model();
    detail.box({ size: [0.1, 0.1, 0.02], center: [0.125, 0.125, 0.01], material: 'bolt' });
    const sheet = sheetOf({
      key: 'mix',
      size: 128,
      density: 256,
      padding: 8,
      modules: [
        {
          id: 'boss',
          size: [0.25, 0.25],
          source: { kind: 'mesh', detail, backing: { material: 'plate' } },
        },
        { id: 'paint', size: [0.125, 0.125], source: { kind: 'flat', material: 'paint' } },
        {
          id: 'split',
          size: [0.125, 0.125],
          source: {
            kind: 'analytic',
            height: () => 0,
            material: (s) => (s < 0.0625 ? 'plate' : 'glow'),
          },
        },
      ],
    });
    const stored: string[] = [];
    const baked = bakeTrimSheet(sheet, {
      maps: ['materialId', 'normal'],
      samples: 1,
      ao: { rays: 4 },
      texture: (key) => {
        stored.push(key);
        return { kind: 'texture', key } as never;
      },
    });
    if (!baked.ok) throw baked.error;
    expect(stored).toEqual(['mix-materialId', 'mix-normal']);
    expect(baked.value.materials.map((m) => m.slot)).toEqual(['bolt', 'plate', 'paint', 'glow']);
    const id = baked.value.textures.materialId as TextureAsset;
    const at = (x: number, y: number) =>
      Array.from((id.data as Uint8Array).subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 3));
    for (const region of Object.values(sheet.regions)) {
      const [x0, y0, w, h] = region.rect;
      for (let d = 1; d <= 4; d++) {
        for (let j = y0; j < y0 + h; j++) {
          if (x0 - d >= 0) expect(at(x0 - d, j)).toEqual(at(x0, j));
          if (x0 + w - 1 + d < 128) expect(at(x0 + w - 1 + d, j)).toEqual(at(x0 + w - 1, j));
        }
      }
    }
    const boss = sheet.regions.boss as TrimRegion;
    const center = at(boss.rect[0] + boss.rect[2] / 2, boss.rect[1] + boss.rect[3] / 2);
    const corner = at(boss.rect[0] + 1, boss.rect[1] + 1);
    expect(center).not.toEqual(corner);
    const split = sheet.regions.split as TrimRegion;
    expect(at(split.rect[0] + 2, split.rect[1] + 2)).toEqual(corner);
    expect(at(split.rect[0] + split.rect[2] - 2, split.rect[1] + 2)).not.toEqual(corner);
    const bad = bakeTrimSheet(sheet, { maps: ['resample' as never] });
    expect(bad.ok).toBe(false);
    expect(bakeTrimSheet(sheet, { maps: ['normal'], samples: 3 as never }).ok).toBe(false);
  });
});
