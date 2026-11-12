import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { bakeMaps } from '../bake';
import { model } from '../model';
import { sel } from '../selectors';
import { type ThinHoleOptions, type ThinHolePlan, thinHole, thinHoleCheck } from '../thin-hole';
import { texel } from './bake-gates';

const RES = 128;
/** A 60 mm square vent tile: 6 x 6 holes of 6 mm on a 10 mm pitch in a 1.5 mm plate. */
const VENT: ThinHoleOptions = {
  width: 0.06,
  height: 0.06,
  diameter: 0.006,
  pitch: 0.01,
  thickness: 0.0015,
  resolution: RES,
};

function plan(options: Partial<ThinHoleOptions> = {}): ThinHolePlan {
  const r = thinHole({ ...VENT, ...options });
  if (!r.ok) throw r.error;
  return r.value;
}

function bake(p: ThinHolePlan, settings: Partial<ThinHolePlan['settings']> = {}) {
  const r = bakeMaps({ base: p.base, detail: p.detail, ...p.settings, ...settings });
  if (!r.ok) throw r.error;
  return r.value;
}

const area = (ring: readonly (readonly [number, number])[]) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i] as [number, number];
    const [x1, y1] = ring[(i + 1) % ring.length] as [number, number];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
};

/** Texel at the center of hole `k` and at the center of the web between holes 0 and 1. */
function sample(p: ThinHolePlan, texture: TextureAsset, point: readonly [number, number]) {
  const x = Math.min(RES - 1, Math.floor((point[0] / p.width) * RES));
  const y = Math.min(RES - 1, Math.floor((point[1] / p.height) * RES));
  return texel(texture, RES, x, y);
}

const centroid = (ring: readonly (readonly [number, number])[]): [number, number] => [
  ring.reduce((s, q) => s + q[0], 0) / ring.length,
  ring.reduce((s, q) => s + q[1], 0) / ring.length,
];

describe('thinHole: geometry', () => {
  it('lays a grid of whole holes whose exact open fraction matches the cut plate', () => {
    const p = plan();
    expect(p.holes).toHaveLength(36);
    const open = p.holes.reduce((s, ring) => s + area(ring), 0) / (p.width * p.height);
    expect(p.openFraction).toBeCloseTo(open, 12);
    const report = p.detail.validate();
    expect(report.pass).toBe(true);
    expect(report.closed).toBe(true);
    expect(report.boundaryEdges).toBe(0);
    expect(report.volume).toBeCloseTo(
      p.width * p.height * (1 - p.openFraction) * VENT.thickness,
      12,
    );
    expect(p.base.validate().pass).toBe(true);
  });

  it('puts the plate top on the base plane and the base uv0 over the whole tile', () => {
    const p = plan();
    const box = p.detail.bounds(sel.all());
    if (!box.ok) throw box.error;
    expect(box.value.max[2]).toBeCloseTo(0, 12);
    expect(box.value.min[2]).toBeCloseTo(-VENT.thickness, 12);
    expect(box.value.max[0]).toBeCloseTo(p.width, 12);
    const mesh = p.base.editMesh;
    const uvs = mesh
      .faces()
      .flatMap((f) =>
        mesh.faceHalves(f).map((h) => Array.from(mesh.corner('uv0', h) ?? []).join()),
      );
    expect(uvs.sort()).toEqual(['0,0', '0,1', '1,0', '1,1']);
  });

  it('staggers hex rows and keeps every hole inside the tile', () => {
    const p = plan({ pattern: 'hex' });
    expect(p.holes.length).toBeGreaterThan(20);
    for (const ring of p.holes) {
      for (const [x, y] of ring) {
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(p.width);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(p.height);
      }
    }
    const xs = new Set(p.holes.map((r) => centroid(r)[0].toFixed(6)));
    expect(xs.size).toBeGreaterThan(6);
    expect(p.detail.validate().pass).toBe(true);
  });

  it.each([
    ['diameter at the pitch', { diameter: 0.01 }],
    ['zero thickness', { thickness: 0 }],
    ['a recess deeper than the plate', { mode: 'recess' as const, depth: 0.002 }],
    ['a tile no hole fits', { width: 0.004 }],
    ['too few segments', { segments: 2 }],
  ])('rejects %s with model-invalid-argument', (_name, bad) => {
    const r = thinHole({ ...VENT, ...bad });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });
});

describe('thinHole: opacity mode (gate)', () => {
  it('cuts the holes by opacity, keeps their coverage on every mip and leaves the height flat', {
    timeout: 60000,
  }, () => {
    const p = plan();
    const baked = bake(p);
    const opacity = baked.textures.opacity as TextureAsset;
    const height = baked.textures.height as TextureAsset;
    for (const ring of p.holes) {
      const c = centroid(ring);
      expect(sample(p, opacity, c)[3]).toBe(0);
      expect(sample(p, height, c)[0]).toBeGreaterThan(0.98);
    }
    const web = sample(p, opacity, [0.01, 0.02]);
    expect(web[3]).toBe(1);
    const report = thinHoleCheck(baked, p);
    expect(report.pass).toBe(true);
    expect(report.measured.length).toBeGreaterThanOrEqual(3);
    expect(report.expected).toBeCloseTo(1 - p.openFraction, 12);
    expect(report.maxError).toBeLessThan(0.05);
    expect(baked.issues.filter((i) => i.code === 'opacity-coverage')).toEqual([]);
  });

  it('falsifier: a detail with a backing plate and default settings fills the holes, and the check says so', {
    timeout: 60000,
  }, () => {
    const p = plan();
    const backed = model();
    backed.append(p.detail);
    backed.plane({ width: p.width, height: p.height, center: [p.width / 2, p.height / 2, -0.008] });
    const r = bakeMaps({
      base: p.base,
      detail: backed,
      maps: ['opacity', 'height'],
      resolution: RES,
      samples: 4,
    });
    if (!r.ok) throw r.error;
    const report = thinHoleCheck(r.value, p);
    expect(report.pass).toBe(false);
    expect(report.measured[0]).toBeGreaterThan(0.99);
  });
});

describe('thinHole: recess mode (gate)', () => {
  it('bakes a shallow recess into the height map and keeps the surface opaque', {
    timeout: 60000,
  }, () => {
    const p = plan({ mode: 'recess', depth: 0.0008 });
    const baked = bake(p);
    expect(baked.textures.opacity).toBeUndefined();
    const height = baked.textures.height as TextureAsset;
    for (const ring of p.holes) expect(sample(p, height, centroid(ring))[0]).toBeLessThan(0.02);
    expect(sample(p, height, [0.01, 0.02])[0]).toBeGreaterThan(0.98);
    const report = thinHoleCheck(baked, p);
    expect(report.pass).toBe(true);
    expect(report.expected).toBeCloseTo(p.openFraction, 12);
    const valid = p.detail.validate();
    expect(valid.pass && valid.closed).toBe(true);
    expect(valid.volume).toBeCloseTo(
      p.width * p.height * VENT.thickness - p.openFraction * p.width * p.height * 0.0008,
      12,
    );
    const box = p.detail.bounds(sel.all());
    if (!box.ok) throw box.error;
    expect(box.value.max[2]).toBeCloseTo(0, 12);
  });
});
