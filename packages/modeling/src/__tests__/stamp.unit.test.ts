import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { recipes } from '../recipes';
import { sel } from '../selectors';
import { type Stamp, stamp } from '../stamp';
import {
  bakeTrimSheet,
  type TrimModule,
  type TrimRegion,
  type TrimSheet,
  trimSheet,
} from '../trim';

/** The stamp bakes take several seconds alone, so loaded runs need more than the package default. */
const SLOW = { timeout: 120_000 };

type V3 = [number, number, number];

function sheetOf(size: number, density: number, modules: TrimModule[]): TrimSheet {
  const r = trimSheet({ key: 'stamps', size, density, padding: 4, modules });
  if (!r.ok) throw r.error;
  return r.value;
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

const texel = (t: TextureAsset, x: number, y: number): V3 => {
  const size = t.shape.extent.width;
  const d = t.data as Uint8Array;
  const o = (y * size + x) * 4;
  return [0, 1, 2].map((c) => ((d[o + c] as number) / 255) * 2 - 1) as V3;
};
const angle = (a: V3, b: V3) => {
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
};
const p95 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.95)] as number;
};

/** Per-texel normal angles between two bakes over one region. */
function normalAngles(a: TextureAsset, b: TextureAsset, region: TrimRegion): number[] {
  const [x0, y0, w, h] = region.rect;
  const out: number[] = [];
  for (let j = y0; j < y0 + h; j++)
    for (let i = x0; i < x0 + w; i++) out.push(angle(texel(a, i, j), texel(b, i, j)));
  return out;
}

describe('stamp.boltHex against recipes.hexBolt (BK17 gate)', () => {
  const M12 = { across: 0.018, height: 0.0075 };
  const analytic = must(stamp.boltHex(M12));
  const side = analytic.size[0];
  /** The M12 recipe bolt stood up on the module plane: head on z = 0..k, centered. */
  function meshBolt() {
    const part = must(recipes.hexBolt({ size: 'M12', length: 0.024 }));
    part.model.rotate(sel.all(), 'x', 90);
    part.model.translate(sel.all(), [side / 2, side / 2, 0]);
    return part.model;
  }
  const settings = {
    maps: ['normal', 'ao'] as const,
    samples: 4 as const,
    ao: { rays: 32 },
    cage: { offset: 0.012 },
  };
  const density = Math.round(60 / side);
  const mesh = sheetOf(128, density, [
    {
      id: 'bolt',
      size: analytic.size,
      source: { kind: 'mesh', detail: meshBolt(), backing: true },
    },
  ]);
  const meshBake = must(bakeTrimSheet(mesh, settings));

  it('matches the high-poly bake in tangent (= object) space: p95 <= 5 degrees', SLOW, () => {
    const field = sheetOf(128, density, [{ id: 'bolt', ...analytic }]);
    expect(field.regions.bolt?.rect).toEqual(mesh.regions.bolt?.rect);
    const fieldBake = must(bakeTrimSheet(field, settings));
    const angles = normalAngles(
      meshBake.textures.normal as TextureAsset,
      fieldBake.textures.normal as TextureAsset,
      mesh.regions.bolt as TrimRegion,
    );
    expect(p95(angles)).toBeLessThanOrEqual(5);
    expect(angles.filter((a) => a > 5).length / angles.length).toBeLessThan(0.02);
    // The horizon AO of the field agrees with the ray AO of the high poly (mean absolute error).
    const [x0, y0, w, h] = (mesh.regions.bolt as TrimRegion).rect;
    const a = meshBake.textures.ao?.data as Uint8Array;
    const b = fieldBake.textures.ao?.data as Uint8Array;
    let mae = 0;
    for (let j = y0; j < y0 + h; j++) {
      for (let i = x0; i < x0 + w; i++)
        mae += Math.abs((a[(j * 128 + i) * 4] as number) - (b[(j * 128 + i) * 4] as number)) / 255;
    }
    expect(mae / (w * h)).toBeLessThan(0.035);
  });

  it('a 20 % larger head misses the gate (falsifier)', SLOW, () => {
    const wide = must(
      stamp.boltHex({
        ...M12,
        across: 1.2 * M12.across,
        chamfer: 0.05 * M12.across,
        margin: 1.15 / 1.2 - 1,
      }),
    );
    expect(wide.size[0]).toBeCloseTo(side, 12);
    const field = sheetOf(128, density, [{ id: 'bolt', ...wide }]);
    const angles = normalAngles(
      meshBake.textures.normal as TextureAsset,
      must(bakeTrimSheet(field, settings)).textures.normal as TextureAsset,
      mesh.regions.bolt as TrimRegion,
    );
    expect(p95(angles)).toBeGreaterThan(5);
  });
});

describe('stamp library', () => {
  const all: [string, Stamp][] = [
    [
      'bolt',
      must(
        stamp.boltHex({ across: 0.03, height: 0.012, washer: { diameter: 0.045, height: 0.003 } }),
      ),
    ],
    ['rivet', must(stamp.rivet({ diameter: 0.02 }))],
    ['hole', must(stamp.hole({ diameter: 0.02, depth: 0.01, chamfer: 0.002 }))],
    ['slot', must(stamp.slot({ length: 0.06, width: 0.015, depth: 0.008 }))],
    ['groove', must(stamp.groove({ width: 0.01, depth: 0.004, length: 0.8 }))],
    [
      'perf',
      must(
        stamp.perforation({
          diameter: 0.01,
          pitch: 0.025,
          depth: 0.005,
          pattern: 'staggered',
          length: 0.8,
        }),
      ),
    ],
    ['tread', must(stamp.treadPlate({ pitch: 0.05, length: 0.8 }))],
    // pitch / sin(angle) = 0.025 m, 8 texels: one period in whole texels for the seam check.
    [
      'knurl',
      must(
        stamp.knurl({
          pitch: 0.025 * Math.sin((40 * Math.PI) / 180),
          depth: 0.003,
          angle: 40,
          rows: 2,
          length: 0.8,
        }),
      ),
    ],
    [
      'weld',
      must(stamp.weldBead({ width: 0.03, ripple: { pitch: 0.0125, depth: 0.15 }, length: 0.8 })),
    ],
    ['label', must(stamp.text({ text: 'B-07', height: 0.08, depth: -0.002, material: 'paint' }))],
  ];
  const modules: TrimModule[] = all.map(([id, s]) => ({ id, ...s }));
  const sheet = sheetOf(256, 320, modules);
  const maps = ['normal', 'height', 'ao', 'materialId', 'curvature'] as const;
  const baked = must(bakeTrimSheet(sheet, { maps: [...maps], samples: 1, ao: { rays: 8 } }));

  it(
    'every stamp carries a signature key, strips tile, and the bake is byte-deterministic',
    SLOW,
    () => {
      for (const [id, s] of all) {
        expect(s.signature.id).toMatch(/^stamp\./);
        expect(sheet.regions[id]?.key).toMatch(/^[0-9a-f]{16}$/);
      }
      expect(sheet.metrics.strips).toBe(5);
      expect(baked.report.cacheKey).toMatch(/^[0-9a-f]{16}$/);
      const again = must(bakeTrimSheet(sheet, { maps: [...maps], samples: 1, ao: { rays: 8 } }));
      for (const map of maps) expect(again.textures[map]?.data).toEqual(baked.textures[map]?.data);
      const normal = baked.textures.normal as TextureAsset;
      for (const id of ['groove', 'perf', 'tread', 'knurl', 'weld']) {
        const region = sheet.regions[id] as TrimRegion;
        const [x0, y0, w, h] = region.rect;
        let worst = 0;
        for (let j = y0; j < y0 + h; j++) {
          // The wrap pair matches the same-phase interior pair one period earlier.
          const periodTexels = Math.round((region.period ?? region.size[0]) * region.density[0]);
          const k = x0 + w - periodTexels;
          const wrap = angle(texel(normal, x0 + w - 1, j), texel(normal, x0, j));
          const inner = angle(texel(normal, k - 1, j), texel(normal, k, j));
          worst = Math.max(worst, Math.abs(wrap - inner));
        }
        expect(worst, id).toBeLessThanOrEqual(1);
      }
    },
  );

  it('raises heads, cuts holes and engraves text with their materials', () => {
    const height = baked.textures.height?.data as Uint8Array;
    const center = (id: string) => {
      const [x, y, w, h] = (sheet.regions[id] as TrimRegion).rect;
      return height[((y + (h >> 1)) * 256 + x + (w >> 1)) * 4] as number;
    };
    expect(center('bolt')).toBeGreaterThan(128);
    expect(center('rivet')).toBeGreaterThan(128);
    expect(center('hole')).toBeLessThan(128);
    expect(center('slot')).toBeLessThan(128);
    expect(baked.materials.map((m) => m.slot)).toEqual(
      expect.arrayContaining(['trim-base', 'hole', 'weld', 'paint']),
    );
    const label = sheet.regions.label as TrimRegion;
    let engraved = 0;
    const [x0, y0, w, h] = label.rect;
    for (let j = y0; j < y0 + h; j++)
      for (let i = x0; i < x0 + w; i++) if ((height[(j * 256 + i) * 4] as number) < 120) engraved++;
    expect(engraved / (w * h)).toBeGreaterThan(0.05);
    expect(engraved / (w * h)).toBeLessThan(0.5);
  });

  it('rejects bad parameters with model-invalid-argument', () => {
    const codes = [
      stamp.boltHex({ across: 0, height: 0.01 }),
      stamp.boltHex({ across: 0.02, height: 0.01, chamfer: 0.02 }),
      stamp.rivet({ diameter: -1 }),
      stamp.hole({ diameter: 0.01, depth: Number.NaN }),
      stamp.slot({ length: 0.01, width: 0.02, depth: 0.01 }),
      stamp.groove({ width: 0.01, depth: 0.004, profile: 'w' as never }),
      stamp.perforation({ diameter: 0.03, pitch: 0.02, depth: 0.01 }),
      stamp.treadPlate({ pitch: 0.05, rows: 0 }),
      stamp.knurl({ pitch: 0.01, depth: 0.002, angle: 80 }),
      stamp.weldBead({ width: 0.02, ripple: { pitch: 0.01, depth: 1.5 } }),
      stamp.text({ text: 'A', height: 0.02, depth: 0 }),
      stamp.text({ text: '%', height: 0.02, depth: 0.001 }),
    ].map((r) => (r.ok ? 'ok' : r.error.code));
    expect(codes.every((c) => c === 'model-invalid-argument')).toBe(true);
  });
});
