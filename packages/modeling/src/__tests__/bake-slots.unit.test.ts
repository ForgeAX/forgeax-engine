import { describe, expect, it } from 'vitest';
import { type BakeOptions, bakeMaps } from '../bake';
import { model } from '../model';
import { sel } from '../selectors';
import { bakeTrimSheet, trimSheet } from '../trim';

/**
 * Slot maps: `baseColor` and `emissive` read the one `slots` table `ormh` reads, through
 * the bake's own correspondence. Gate: a hull plate with a raised glow strip bakes an
 * emissive map that covers exactly the strip's projection (IoU >= 0.95 against an
 * independent raster of the high's glow faces) and is zero elsewhere.
 */

const RES = 64;
/** Strip footprint: x in [-0.1, 0.1] m, the full plate height. */
const STRIP = 0.1;

function base() {
  const m = model();
  m.plane({ width: 1, height: 1 });
  const mesh = m.editMesh;
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      const [x, y] = mesh.position(mesh.hVert[h] as number) as [number, number, number];
      mesh.setCorner('uv0', h, [x + 0.5, y + 0.5]);
    }
  }
  return m;
}

/** The hull plate (slot hull) and a 0.2 m strip 5 mm above it (slot glow) with 45 degree flanks. */
function detail(glow = 'glow') {
  const m = model();
  m.polygon({
    points: [
      [-0.5, -0.5, 0],
      [-STRIP - 0.005, -0.5, 0],
      [-STRIP - 0.005, 0.5, 0],
      [-0.5, 0.5, 0],
    ],
  });
  m.polygon({
    points: [
      [STRIP + 0.005, -0.5, 0],
      [0.5, -0.5, 0],
      [0.5, 0.5, 0],
      [STRIP + 0.005, 0.5, 0],
    ],
  });
  m.polygon({
    points: [
      [-STRIP - 0.005, -0.5, 0],
      [-STRIP, -0.5, 0.005],
      [-STRIP, 0.5, 0.005],
      [-STRIP - 0.005, 0.5, 0],
    ],
  });
  m.polygon({
    points: [
      [STRIP, -0.5, 0.005],
      [STRIP + 0.005, -0.5, 0],
      [STRIP + 0.005, 0.5, 0],
      [STRIP, 0.5, 0.005],
    ],
  });
  m.assign(sel.all(), 'hull');
  m.polygon({
    points: [
      [-STRIP, -0.5, 0.005],
      [STRIP, -0.5, 0.005],
      [STRIP, 0.5, 0.005],
      [-STRIP, 0.5, 0.005],
    ],
  });
  m.assign(sel.inBox([-STRIP + 1e-4, -1, 0.004], [STRIP - 1e-4, 1, 1], { by: 'centroid' }), glow);
  return m;
}

const SLOTS = {
  hull: { baseColor: [0.5, 0.5, 0.5, 1], roughness: 0.6, metallic: 1 },
  glow: { baseColor: [0.2, 1, 0.8, 1], emissive: [0, 1, 0.8], emissiveIntensity: 4 },
} as const;

function bake(extra: Partial<BakeOptions> = {}) {
  const r = bakeMaps({
    base: base(),
    detail: detail(),
    maps: ['emissive', 'baseColor', 'ormh', 'opacity'],
    resolution: RES,
    filter: 'none',
    cage: { offset: 0.01, maxRay: 0.02 },
    slots: SLOTS,
    ...extra,
  });
  if (!r.ok) throw r.error;
  return r.value;
}

/** Texel centers inside the strip's projection, rasterized here (not by the bake). */
const inStrip = (i: number) => Math.abs((i % RES) + 0.5 - RES / 2) / RES < STRIP;

describe('slot maps: baseColor and emissive from one slot table (U89 gate)', () => {
  it('the emissive covers the glow strip (IoU >= 0.95), zero elsewhere; scale = brightest slot', () => {
    const r = bake();
    expect(r.provenance.emissiveScale).toBe(4);
    const e = r.textures.emissive?.data as Uint8Array;
    let both = 0;
    let either = 0;
    let outside = 0;
    for (let i = 0; i < RES * RES; i++) {
      const lit = (e[i * 4 + 1] as number) > 0;
      const strip = inStrip(i);
      if (lit && strip) both++;
      if (lit || strip) either++;
      if (lit && !strip) outside += e[i * 4 + 1] as number;
    }
    expect(both / either).toBeGreaterThanOrEqual(0.95);
    expect(outside).toBe(0);
    const center = ((RES / 2) * RES + RES / 2) * 4;
    // Linear green 1 x 4 over scale 4 stores 255; red 0.
    expect([e[center], e[center + 1], e[center + 2]]).toEqual([0, 255, 204]);
    const c = r.textures.baseColor?.data as Uint8Array;
    expect(r.textures.baseColor?.colorSpace).toBe('srgb');
    // The slot colors are sRGB: they round-trip to their bytes.
    expect([c[center], c[center + 1], c[center + 2], c[center + 3]]).toEqual([51, 255, 204, 255]);
    const hull = (8 * RES + 8) * 4;
    expect([c[hull], c[hull + 1], c[hull + 2]]).toEqual([128, 128, 128]);
    const ormh = r.textures.ormh?.data as Uint8Array;
    expect([ormh[hull + 1], ormh[hull + 2]]).toEqual([153, 255]);
  });

  it('falsifiers: without a glow entry nothing glows; swapped slot names move the glow; alpha scales opacity', () => {
    const none = bake({ slots: { hull: SLOTS.hull } });
    expect(
      (none.textures.emissive?.data as Uint8Array).every((v, i) => i % 4 === 3 || v === 0),
    ).toBe(true);
    const swapped = bakeMaps({
      base: base(),
      detail: detail(),
      maps: ['emissive'],
      resolution: RES,
      filter: 'none',
      cage: { offset: 0.01, maxRay: 0.02 },
      slots: { hull: { emissive: [1, 1, 1] }, glow: {} },
    });
    if (!swapped.ok) throw swapped.error;
    const s = swapped.value.textures.emissive?.data as Uint8Array;
    const center = ((RES / 2) * RES + RES / 2) * 4;
    expect(s[center]).toBe(0);
    expect(s[(8 * RES + 8) * 4]).toBe(255);
    const faded = bake({
      slots: { ...SLOTS, hull: { ...SLOTS.hull, baseColor: [0.5, 0.5, 0.5, 0.3] } },
    });
    const o = faded.textures.opacity?.data as Uint8Array;
    expect(o[(8 * RES + 8) * 4]).toBe(77);
    expect(o[center]).toBe(255);
  });

  it('a slot field out of range is model-invalid-argument; a misspelt one names itself', () => {
    const bad = bakeMaps({
      base: base(),
      detail: detail(),
      maps: ['emissive'],
      resolution: 16,
      slots: { glow: { roughness: 2 } },
    });
    expect(bad.ok ? undefined : bad.error.code).toBe('model-invalid-argument');
    const typo = bakeMaps({
      base: base(),
      detail: detail(),
      maps: ['emissive'],
      resolution: 16,
      slots: { glow: { emission: [1, 1, 1] } },
    } as never);
    expect(typo.ok ? undefined : typo.error.detail?.option).toBe('slots.glow.emission');
  });

  it('a trim sheet reads the same table: an analytic glow line bakes into its emissive map', () => {
    const sheet = trimSheet({
      key: 'glow',
      size: 64,
      density: 320,
      modules: [
        {
          id: 'line',
          size: [0.1, 0.1],
          source: {
            kind: 'analytic',
            height: () => 0,
            material: (s) => (Math.abs(s - 0.05) < 0.02 ? 'glow' : 'hull'),
          },
        },
      ],
    });
    if (!sheet.ok) throw sheet.error;
    const r = bakeTrimSheet(sheet.value, {
      maps: ['emissive', 'baseColor'],
      samples: 1,
      slots: SLOTS,
    });
    if (!r.ok) throw r.error;
    expect(r.value.report.emissiveScale).toBe(4);
    const region = sheet.value.regions.line as { rect: readonly number[] };
    const [x0, y0, w] = region.rect as [number, number, number];
    const e = r.value.textures.emissive?.data as Uint8Array;
    const at = (i: number) => e[((y0 + 4) * 64 + x0 + i) * 4 + 1] as number;
    expect(at(Math.floor(w / 2))).toBe(255);
    expect(at(1)).toBe(0);
  });
});
