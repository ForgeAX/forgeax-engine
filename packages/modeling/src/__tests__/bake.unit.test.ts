import {
  computeTangentVec4,
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type BakeOptions, bakeMaps, bakeSources, createBakeCooker } from '../bake';
import { type BakeSurface, bakeSurface, MATERIAL_ID_PALETTE } from '../compute/bake-ts';
import { decodeSnapshot } from '../fxem';
import { type Model, model } from '../model';
import { sel } from '../selectors';

type V3 = [number, number, number];
const norm = (v: V3): V3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const degrees = (a: V3, b: V3) =>
  (Math.acos(Math.min(1, Math.max(-1, dot3(a, b)))) * 180) / Math.PI;

const AMPLITUDE = 0.02;
const FREQUENCY = 12;
const ROTATION = 30;

/** A flat 1 m square in the xy plane, turned about z, auto-UVed: the low-poly base. */
function flatBase(segments = 2, turn = ROTATION): Model {
  const m = model();
  m.plane({ width: 1, height: 1, widthSegments: segments, heightSegments: segments });
  m.rotate(sel.all(), 'z', turn);
  expect(m.uv.auto({ resolution: 64, padding: 2 }).status).toBe('ok');
  return m;
}

/** The same square, finely divided, with z = A sin(k x') along the turned x axis. */
function bumped(turn = ROTATION): Model {
  const m = model();
  m.plane({ width: 1, height: 1, widthSegments: 48, heightSegments: 48 });
  const mesh = m.editMesh;
  for (const v of mesh.vertices()) {
    const [x, y, z] = mesh.position(v);
    mesh.setPosition(v, x, y, z + AMPLITUDE * Math.sin(x * FREQUENCY));
  }
  m.rotate(sel.all(), 'z', turn);
  return m;
}

/** Analytic unit normal of the bumped detail at a world point. */
function bumpNormal(p: readonly number[], turn = ROTATION): V3 {
  const a = (turn * Math.PI) / 180;
  const xLocal = (p[0] as number) * Math.cos(a) + (p[1] as number) * Math.sin(a);
  const slope = AMPLITUDE * FREQUENCY * Math.cos(xLocal * FREQUENCY);
  // Gradient along the turned x axis.
  return norm([-slope * Math.cos(a), -slope * Math.sin(a), 1]);
}

function surfaceOf(m: Model): BakeSurface {
  const mesh = decodeSnapshot(m.snapshot());
  if (!mesh.ok) throw mesh.error;
  const s = bakeSurface(mesh.value, { mode: 'smooth' });
  if (!s.ok) throw s.error;
  return s.value;
}

interface TexelFrame {
  readonly x: number;
  readonly y: number;
  readonly p: V3;
  readonly n: V3;
  readonly t: V3;
  readonly w: number;
}

/** Texel centers covered by the base atlas with their interpolated vertex frame. */
function texelFrames(s: BakeSurface, size: number): TexelFrame[] {
  const out: TexelFrame[] = [];
  const seen = new Set<number>();
  for (let t = 0; t < s.indices.length / 3; t++) {
    const id = [0, 1, 2].map((k) => s.indices[t * 3 + k] as number);
    const uv = id.map((i) => [
      (s.uv[i * 2] as number) * size,
      (s.uv[i * 2 + 1] as number) * size,
    ]) as [[number, number], [number, number], [number, number]];
    const [p0, p1, p2] = uv;
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (seen.has(y * size + x)) continue;
        const px = x + 0.5;
        const py = y + 0.5;
        const w1 = ((px - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (py - p0[1])) / area;
        const w2 = ((p1[0] - p0[0]) * (py - p0[1]) - (px - p0[0]) * (p1[1] - p0[1])) / area;
        const w = [1 - w1 - w2, w1, w2];
        if (w.some((c) => c < 0)) continue;
        seen.add(y * size + x);
        const lerp = (a: Float32Array, width: number, c: number) =>
          id.reduce((sum, i, k) => sum + (w[k] as number) * (a[i * width + c] as number), 0);
        out.push({
          x,
          y,
          p: [0, 1, 2].map((c) => lerp(s.position, 3, c)) as V3,
          n: norm([0, 1, 2].map((c) => lerp(s.normal, 3, c)) as V3),
          t: [0, 1, 2].map((c) => lerp(s.tangent, 4, c)) as V3,
          w: lerp(s.tangent, 4, 3),
        });
      }
    }
  }
  return out;
}

/** The shaders' decode: RG -> tangent normal with z reconstructed, then applyTBN. */
function shade(texture: TextureAsset, f: TexelFrame, size: number, frame = true): V3 {
  const data = texture.data as Uint8Array;
  const o = (f.y * size + f.x) * 4;
  const x = ((data[o] as number) / 255) * 2 - 1;
  const y = ((data[o + 1] as number) / 255) * 2 - 1;
  const tn: V3 = [x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))];
  const n0 = f.n;
  const tangent: V3 = frame ? f.t : [1, 0, 0];
  const t0 = norm([
    tangent[0] - dot3(tangent, n0) * n0[0],
    tangent[1] - dot3(tangent, n0) * n0[1],
    tangent[2] - dot3(tangent, n0) * n0[2],
  ]);
  const b0 = cross3(n0, t0).map((c) => c * (frame ? f.w : 1)) as V3;
  const mix = (c: 0 | 1 | 2) => t0[c] * tn[0] + b0[c] * tn[1] + n0[c] * tn[2];
  return norm([mix(0), mix(1), mix(2)]);
}

function bake(options: Partial<BakeOptions> & Pick<BakeOptions, 'base' | 'detail' | 'maps'>) {
  const r = bakeMaps({ resolution: 64, filter: 'none', ...options });
  if (!r.ok) throw r.error;
  return r.value;
}

const texel = (t: TextureAsset, size: number, x: number, y: number) =>
  Array.from((t.data as Uint8Array).subarray((y * size + x) * 4, (y * size + x) * 4 + 4));

describe('bake: tangent-space normals match computeTangentVec4 (gate)', () => {
  it('the bake frame is the exported computeTangentVec4 tangent the Renderer receives', () => {
    const base = flatBase();
    const s = surfaceOf(base);
    const recomputed = computeTangentVec4(s.position, s.normal, s.uv, s.indices);
    expect(recomputed.ok).toBe(true);
    if (!recomputed.ok) return;
    expect(Array.from(s.tangent)).toEqual(Array.from(recomputed.value));
    const exported = base.toMesh();
    if (!exported.ok) throw exported.error;
    const attributes = unpackInterleavedVertexAttributes(
      exported.value.mesh.vertices,
      deriveVertexLayoutProjection(exported.value.mesh.attributes),
    ) as unknown as Record<string, Float32Array>;
    expect(Array.from(attributes.tangent as Float32Array)).toEqual(Array.from(s.tangent));
    // The atlas turned the chart: the frame is not the world x axis.
    const t0 = norm([s.tangent[0] as number, s.tangent[1] as number, s.tangent[2] as number]);
    expect(degrees(t0, [1, 0, 0])).toBeGreaterThan(10);
  });

  it('an identity bake is a flat (0, 0, 1) normal map, open AO and mid height', () => {
    const base = flatBase();
    const r = bake({ base, detail: base, maps: ['normal', 'ao', 'height', 'curvature'] });
    const frames = texelFrames(surfaceOf(base), 64);
    expect(frames.length).toBeGreaterThan(1000);
    for (const f of frames) {
      expect(texel(r.textures.normal as TextureAsset, 64, f.x, f.y).slice(0, 3)).toEqual([
        128, 128, 255,
      ]);
      expect(texel(r.textures.ao as TextureAsset, 64, f.x, f.y)[0]).toBe(255);
      expect(texel(r.textures.height as TextureAsset, 64, f.x, f.y)[0]).toBe(128);
      expect(texel(r.textures.curvature as TextureAsset, 64, f.x, f.y)[0]).toBe(128);
    }
    expect(r.provenance.nearest).toBe(0);
    expect(r.report.metrics.rayHitRatio).toBe(1);
  });

  it('a flat base baked from a bumped plane reproduces the detail normals through applyTBN; a world-axis frame does not (falsifier)', () => {
    const base = flatBase();
    const detail = bumped();
    const r = bake({ base, detail, maps: ['normal'] });
    const frames = texelFrames(surfaceOf(base), 64);
    const errors = frames.map((f) =>
      degrees(shade(r.textures.normal as TextureAsset, f, 64), bumpNormal(f.p)),
    );
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    // Measured: mean 0.28, max 0.61 degrees (8-bit RG quantization and the faceted detail).
    expect(mean).toBeLessThan(0.6);
    expect(Math.max(...errors)).toBeLessThan(1.5);
    // The bumps really tilt the normals (up to atan(0.24) = 13.5 degrees).
    const tilt = frames.map((f) => degrees(bumpNormal(f.p), [0, 0, 1]));
    expect(Math.max(...tilt)).toBeGreaterThan(12);
    const wrong = frames.map((f) =>
      degrees(shade(r.textures.normal as TextureAsset, f, 64, false), bumpNormal(f.p)),
    );
    expect(wrong.reduce((a, b) => a + b, 0) / wrong.length).toBeGreaterThan(5);
  });
});

describe('bake evaluators', () => {
  it('height encodes the signed offset over the cage range; beyond the cage it falls back and warns (falsifier)', () => {
    const base = flatBase();
    const lifted = model();
    lifted.append(base);
    lifted.translate(sel.all(), [0, 0, 0.005]);
    const near = bake({
      base,
      detail: lifted,
      maps: ['height'],
      cage: { offset: 0.01, maxRay: 0.02 },
    });
    const f = texelFrames(surfaceOf(base), 64)[40] as TexelFrame;
    expect(texel(near.textures.height as TextureAsset, 64, f.x, f.y)[0]).toBe(191);
    expect(near.issues).toEqual([]);
    const far = model();
    far.append(base);
    far.translate(sel.all(), [0, 0, 0.05]);
    const missed = bake({
      base,
      detail: far,
      maps: ['height'],
      cage: { offset: 0.01, maxRay: 0.02 },
    });
    expect(missed.provenance.rayHits).toBe(0);
    expect(missed.issues).toEqual([
      {
        code: 'ray-miss',
        severity: 'warn',
        detail: { subject: '', samples: expect.any(Number), rayHits: 0 },
      },
    ]);
    expect(texel(missed.textures.height as TextureAsset, 64, f.x, f.y)[0]).toBe(255);
  });

  it('AO darkens the floor next to a block and stays open far from it; a short reach sees nothing (falsifier)', () => {
    const base = flatBase(2, 0);
    const detail = model();
    detail.append(base);
    const block = model();
    block.box({ size: [0.3, 0.3, 0.3], center: [0, 0, 0.15] });
    detail.append(block);
    const r = bake({
      base,
      detail,
      maps: ['ao'],
      cage: { offset: 0.01, maxRay: 0.02 },
      ao: { distance: 0.5 },
    });
    const frames = texelFrames(surfaceOf(base), 64);
    const at = (x: number, y: number) => {
      const f = frames.reduce((best, g) =>
        Math.hypot(g.p[0] - x, g.p[1] - y) < Math.hypot(best.p[0] - x, best.p[1] - y) ? g : best,
      );
      return texel(r.textures.ao as TextureAsset, 64, f.x, f.y)[0] as number;
    };
    expect(at(0.18, 0)).toBeLessThan(200);
    expect(at(0.45, 0.45)).toBeGreaterThan(at(0.18, 0));
    const short = bake({
      base,
      detail,
      maps: ['ao'],
      cage: { offset: 0.01, maxRay: 0.02 },
      ao: { distance: 0.001 },
    });
    const g = frames.find(
      (f) => Math.abs(f.p[0] - 0.18) < 0.02 && Math.abs(f.p[1]) < 0.02,
    ) as TexelFrame;
    expect(texel(short.textures.ao as TextureAsset, 64, g.x, g.y)[0]).toBe(255);
  });

  it('material ids follow the detail slots; curvature is convex-positive on bump crests', () => {
    const base = flatBase(2, 0);
    const detail = bumped(0);
    detail.assign(sel.inBox([0, -9, -9], [9, 9, 9], { by: 'centroid' }), 'metal');
    const r = bake({
      base,
      detail,
      maps: ['materialId', 'curvature'],
      cage: { offset: 0.03, maxRay: 0.06 },
    });
    expect(r.provenance.materials.map((m) => m.slot)).toEqual(['Default', 'metal']);
    const srgb = (c: number) =>
      Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
    const frames = texelFrames(surfaceOf(base), 64);
    for (const f of frames.filter((g) => Math.abs(g.p[0]) > 0.05)) {
      const slot = f.p[0] > 0 ? 1 : 0;
      const color = MATERIAL_ID_PALETTE[slot] as readonly number[];
      expect(texel(r.textures.materialId as TextureAsset, 64, f.x, f.y).slice(0, 3)).toEqual(
        color.map(srgb),
      );
    }
    const crest = frames.filter((f) => Math.abs(Math.sin(f.p[0] * FREQUENCY) - 1) < 0.01);
    const trough = frames.filter((f) => Math.abs(Math.sin(f.p[0] * FREQUENCY) + 1) < 0.01);
    expect(crest.length).toBeGreaterThan(4);
    expect(trough.length).toBeGreaterThan(4);
    for (const f of crest)
      expect(texel(r.textures.curvature as TextureAsset, 64, f.x, f.y)[0]).toBeGreaterThan(160);
    for (const f of trough)
      expect(texel(r.textures.curvature as TextureAsset, 64, f.x, f.y)[0]).toBeLessThan(96);
  });

  it('samples that miss a thinner detail take its nearest facing point, so the base rims stay flat', () => {
    const base = model();
    base.box({ size: [1, 0.06, 1] });
    base.markSharp(sel.edges.dihedral('>', 40));
    base.uv.auto({ resolution: 64, padding: 2 });
    const detail = model();
    detail.box({ size: [0.98, 0.04, 0.98] });
    const normals = { mode: 'autoSmooth', angle: 40 } as const;
    const r = bake({
      base,
      detail,
      maps: ['normal'],
      cage: { offset: 0.017, maxRay: 0.034 },
      direction: 'shading',
      normals,
      detailNormals: normals,
    });
    expect(r.provenance.nearest).toBeGreaterThan(0);
    const data = r.textures.normal?.data as Uint8Array;
    const frames = texelFrames(surfaceOf(base), 64);
    for (const f of frames) expect(data[(f.y * 64 + f.x) * 4 + 2]).toBeGreaterThanOrEqual(250);
  });

  it('resample transfers a detail texture through the detail uv0', () => {
    const base = flatBase(2, 0);
    const detail = model();
    detail.append(base);
    detail.uv.project({ mode: 'box', scale: 1 });
    const data = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) data.set([200, 40, 10, 255], i * 4);
    const source: TextureAsset = {
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      mips: { kind: 'none' },
      data,
    };
    const r = bake({ base, detail, maps: ['resample'], resample: source });
    const f = texelFrames(surfaceOf(base), 64)[100] as TexelFrame;
    expect(texel(r.textures.resample as TextureAsset, 64, f.x, f.y)).toEqual([200, 40, 10, 255]);
    const bare = model();
    bare.plane({ width: 1, height: 1 });
    expect(
      bakeMaps({ base, detail: bare, maps: ['resample'], resolution: 8, resample: source }),
    ).toMatchObject({
      ok: false,
      error: { code: 'model-precondition' },
    });
  });

  it('gutter grows the charts and the B-spline filter keeps a flat map flat; gutter 0 leaves the border neutral (falsifier)', () => {
    const base = flatBase();
    const detail = bumped();
    const frames = texelFrames(surfaceOf(base), 64);
    const covered = new Set(frames.map((f) => f.y * 64 + f.x));
    const r = bake({ base, detail, maps: ['height'], gutter: 3, filter: 'bspline', samples: 4 });
    const none = bake({ base, detail, maps: ['height'], gutter: 0 });
    let grown = 0;
    for (let i = 0; i < 64 * 64; i++) {
      if (covered.has(i)) continue;
      const x = i % 64;
      const y = (i - x) / 64;
      const near = [-1, 0, 1].some((dx) =>
        [-1, 0, 1].some((dy) => covered.has((y + dy) * 64 + x + dx)),
      );
      if (!near) continue;
      grown++;
      expect(texel(none.textures.height as TextureAsset, 64, x, y)[0]).toBe(128);
      expect(texel(r.textures.height as TextureAsset, 64, x, y)[0]).not.toBe(128);
    }
    expect(grown).toBeGreaterThan(20);
    const flat = bake({ base, detail: base, maps: ['normal'], samples: 9, filter: 'bspline' });
    for (const f of frames) {
      expect(texel(flat.textures.normal as TextureAsset, 64, f.x, f.y).slice(0, 3)).toEqual([
        128, 128, 255,
      ]);
    }
  });

  it('the vertex target reuses the evaluators: heights per base corner and a colored base', () => {
    const base = model();
    base.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
    const detail = bumped(0);
    const r = bake({
      base,
      detail,
      maps: ['height', 'normal'],
      target: 'vertex',
      cage: { offset: 0.03, maxRay: 0.06 },
    });
    const heights = r.vertexColors.height as Float32Array;
    const decoded = decodeSnapshot(base.snapshot());
    if (!decoded.ok) throw decoded.error;
    const mesh = decoded.value;
    let i = 0;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const p = mesh.position(mesh.hVert[h] as number);
        expect(heights[i * 4] as number).toBeCloseTo(
          0.5 + (AMPLITUDE * Math.sin(p[0] * FREQUENCY)) / 0.06,
          2,
        );
        i++;
      }
    }
    const colored = model();
    colored.append(r.colored as Uint8Array);
    expect(colored.editMesh.corner('color', 0)?.[0]).toBeCloseTo(heights[0] as number, 6);
    colored.uv.project({ mode: 'box', scale: 1 });
    const exported = colored.toMesh();
    if (!exported.ok) throw exported.error;
    expect(exported.value.mesh.attributes.color).toBeDefined();
  });
});

describe('bake job contract', () => {
  it('is byte deterministic with a stable cache key', () => {
    const base = flatBase();
    const detail = bumped();
    const a = bake({ base, detail, maps: ['normal', 'ao'], ao: { rays: 8 } });
    const b = bake({ base, detail, maps: ['normal', 'ao'], ao: { rays: 8 } });
    expect(b.report.cacheKey).toBe(a.report.cacheKey);
    expect(Array.from(b.textures.ao?.data as Uint8Array)).toEqual(
      Array.from(a.textures.ao?.data as Uint8Array),
    );
    expect(Array.from(b.textures.normal?.data as Uint8Array)).toEqual(
      Array.from(a.textures.normal?.data as Uint8Array),
    );
    const other = bake({ base, detail, maps: ['normal', 'ao'], ao: { rays: 9 } });
    expect(other.report.cacheKey).not.toBe(a.report.cacheKey);
    expect(a.report).toMatchObject({ backend: 'ts', quality: 'baseline' });
  });

  it('reports budget, cancellation, native policy, invalid settings and missing UVs', () => {
    const base = flatBase();
    const detail = bumped();
    const run = (o: Partial<BakeOptions>) =>
      bakeMaps({ base, detail, maps: ['ao'], resolution: 64, ...o });
    expect(run({ budget: 1000 })).toMatchObject({
      ok: false,
      error: { code: 'model-work-budget' },
    });
    expect(run({ signal: { aborted: true } })).toMatchObject({
      ok: false,
      error: { code: 'model-cancelled' },
    });
    expect(run({ compute: 'native' })).toMatchObject({
      ok: false,
      error: { code: 'model-capability-unavailable' },
    });
    for (const bad of [
      { maps: [] },
      { maps: ['normal', 'normal'] },
      { maps: ['gloss'] },
      { resolution: undefined },
      { samples: 3 },
      { cage: { offset: -1 } },
      { cage: { maxRay: 0 } },
      { gutter: 'wide' },
      { protectMip: -1 },
      { direction: 'cage' },
      { direction: { blend: 0 } },
      { direction: { face: '' } },
      { tags: { groupPrefix: '' } },
      { groups: { a: { cage: { offset: Number.NaN } } } },
      { ao: { scope: 'world' } },
      { tags: { floater: '' } },
      { target: 'vertex', direction: 'face' },
      { gutter: -1 },
      { ao: { rays: 0 } },
      { ao: { bias: 90 } },
    ] as Partial<BakeOptions>[]) {
      expect(run(bad)).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
    }
    const bare = model();
    bare.plane({ width: 1, height: 1 });
    expect(bakeMaps({ base: bare, detail, maps: ['normal'], resolution: 8 })).toMatchObject({
      ok: false,
      error: { code: 'model-precondition', detail: { input: 'base' } },
    });
    const outside = model();
    outside.plane({ width: 1, height: 1 });
    outside.uv.project({ mode: 'box', scale: 1 });
    outside.translate(sel.all(), [0, 0, 0]);
    const shifted = model();
    shifted.append(outside);
    const mesh = shifted.editMesh;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const uv = mesh.corner('uv0', h) as Float32Array;
        mesh.setCorner('uv0', h, [(uv[0] as number) + 5, uv[1] as number]);
      }
    }
    expect(bakeMaps({ base: shifted, detail, maps: ['normal'], resolution: 8 })).toMatchObject({
      ok: false,
      error: { code: 'model-precondition' },
    });
  });
});

describe('bake through PackCookSource + NativeCooker', () => {
  it('bakeSources encodes each snapshot byte-exactly across encoding chunks', () => {
    const base = flatBase();
    const detail = bumped();
    const sources = bakeSources({ base, detail, maps: ['normal'], resolution: 8, key: 'chunks' });
    if (!sources.ok) throw sources.error;
    const source = sources.value['texture/chunks-normal']?.source as {
      base: string;
      detail: string;
    };
    const [b, d] = [base.snapshot(), detail.snapshot()];
    // The encoder works in 24 KiB chunks: the detail snapshot spans several, with a partial last one.
    expect(d.length).toBeGreaterThan(2 * 3 * 8192);
    expect(d.length % (3 * 8192)).not.toBe(0);
    expect(source.base).toBe(Buffer.from(b).toString('base64'));
    expect(source.detail).toBe(Buffer.from(d).toString('base64'));
  });
  it('bakeSources cooks to the same texture as bakeMaps, as an ordinary texture payload', async () => {
    const base = flatBase();
    const detail = bumped();
    const sources = bakeSources({
      base,
      detail,
      maps: ['normal', 'height'],
      resolution: 32,
      key: 'plate',
      mips: false,
    });
    if (!sources.ok) throw sources.error;
    expect(Object.keys(sources.value)).toEqual(['texture/plate-normal', 'texture/plate-height']);
    const entry = sources.value['texture/plate-normal'];
    expect(entry).toMatchObject({ kind: 'modeling-bake', execution: 'cooked' });
    const registry = new NativeCookerRegistry();
    registry.register(createBakeCooker());
    const guid = '01900000-0000-7000-8000-00000000b4ce';
    const transported = JSON.parse(JSON.stringify(entry?.source));
    const draft = await registry.runDraft('modeling-bake', { guid, source: transported });
    if (!draft.ok) throw new Error(JSON.stringify(draft.error));
    const direct = bake({
      base,
      detail,
      maps: ['normal', 'height'],
      resolution: 32,
      filter: 'bspline',
      mips: false,
    });
    const payload = draft.value.payload as TextureAsset;
    expect(payload.kind).toBe('texture');
    expect(Array.from(payload.data as Uint8Array)).toEqual(
      Array.from(direct.textures.normal?.data as Uint8Array),
    );
    expect(draft.value.guid).toBe(guid);
    const height = await registry.runDraft('modeling-bake', {
      guid,
      source: JSON.parse(JSON.stringify(sources.value['texture/plate-height']?.source)),
    });
    if (!height.ok) throw new Error(JSON.stringify(height.error));
    expect(Array.from((height.value.payload as TextureAsset).data as Uint8Array)).toEqual(
      Array.from(direct.textures.height?.data as Uint8Array),
    );
    expect(height.value.inputFingerprint).not.toBe(draft.value.inputFingerprint);
    const malformed = await registry.runDraft('modeling-bake', {
      guid,
      source: { ...transported, extra: 1 },
    });
    expect(malformed).toMatchObject({ ok: false, error: { code: 'native-cook-failed' } });
    expect(
      bakeSources({ base, detail, maps: ['resample'], resolution: 8, key: 'x' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'model-invalid-argument' },
    });
  });
});
