import { bakeWorkers } from '@forgeax/engine-modeling/tools';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type BakeOptions, bakeMaps, bakeMapsParallel, bakeSources } from '../bake';
import { MATERIAL_ID_PALETTE, tsBakeBackend } from '../compute/bake-ts';
import { type BakeDirection, type BakeJobParams, runComputeJob } from '../compute/job';
import { type Model, model } from '../model';
import { sel } from '../selectors';
import { defaultProtectMip, paddingTexels } from '../uv';
import {
  applyTbn,
  degrees,
  mean,
  norm,
  percentile,
  roundedBoxNormal,
  seamAngles,
  surfaceOf,
  type TexelFrame,
  texel,
  texelFrames,
  traceRoundedBox,
  type V3,
} from './bake-gates';

/**
 * B20 S1a gates: bake groups, the averaged-normal cage with automatic extent,
 * ray direction modes and mip-aware padding with a full gutter (U36, V4). Each gate
 * measures quality numerically against analytic truth or a geometric invariant, and each
 * has a falsifier: the same measurement with the feature off must fail.
 */

const HARD = { mode: 'autoSmooth', angle: 40 } as const;

function bake(options: BakeOptions) {
  const r = bakeMaps(options);
  if (!r.ok) throw r.error;
  return r.value;
}

/** A hard-edged box low poly with every hard edge a UV seam. */
function hardBox(size: V3, resolution: number, center: V3 = [0, 0, 0]): Model {
  const m = model();
  m.box({ size, center });
  m.markSharp(sel.edges.dihedral('>', 40));
  expect(m.uv.auto({ resolution, padding: 8 }).status).toBe('ok');
  return m;
}

const srgbByte = (c: number) =>
  Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
const isSlot = (id: TextureAsset, size: number, f: TexelFrame, slot: number) => {
  const color = (MATERIAL_ID_PALETTE[slot] as readonly number[]).map(srgbByte);
  return texel(id, size, f.x, f.y)
    .slice(0, 3)
    .every((v, k) => Math.round(v * 255) === color[k]);
};

describe('bake cage: a rounded box onto its hard-edged low poly (gate)', () => {
  const S = 0.1;
  const R = 0.004;
  const RES = 512;
  const low = hardBox([S, S, S], RES);
  const high = model();
  high.box({ size: [S, S, S] });
  high.bevel(sel.edges.all(), { width: R, segments: 8 });
  const surface = surfaceOf(low, HARD);
  const frames = texelFrames(surface, RES);
  const run = (direction: BakeDirection, cage?: BakeOptions['cage']) =>
    bake({
      base: low,
      detail: high,
      maps: ['normal'],
      resolution: RES,
      normals: HARD,
      detailNormals: { mode: 'weighted' },
      direction,
      filter: 'none',
      ...(cage === undefined ? {} : { cage }),
    });
  /** Angular error of the decoded map against the exact rounded-box normal where the bake ray meets it. */
  const accuracy = (
    r: ReturnType<typeof run>,
    averaged: boolean,
    truth: ReturnType<typeof run> = r,
  ) => {
    const g = truth.provenance.groups[0] as NonNullable<(typeof r.provenance.groups)[0]>;
    const errors: number[] = [];
    for (const f of frames) {
      const ids = [0, 1, 2].map((k) => surface.indices[f.triangle * 3 + k] as number);
      // The averaged normal of a cube corner is its diagonal: interpolate and normalize.
      const c = averaged
        ? norm(
            [0, 1, 2].map((axis) =>
              ids.reduce(
                (s, i, k) =>
                  s +
                  ((f.bary[k] as number) * Math.sign(surface.position[i * 3 + axis] as number)) /
                    Math.sqrt(3),
                0,
              ),
            ),
          )
        : f.n;
      const origin: V3 = [
        f.p[0] + c[0] * g.offset,
        f.p[1] + c[1] * g.offset,
        f.p[2] + c[2] * g.offset,
      ];
      const hit = traceRoundedBox(origin, [-c[0], -c[1], -c[2]], g.maxRay, S / 2, R);
      if (hit === undefined) continue;
      const decoded = applyTbn(
        texel(r.textures.normal as TextureAsset, RES, f.x, f.y),
        f.n,
        f.t,
        f.w,
      );
      errors.push(degrees(decoded, roundedBoxNormal(hit, S / 2, R)));
    }
    return errors;
  };
  const seams = (r: ReturnType<typeof run>) =>
    seamAngles(surface, r.textures.normal as TextureAsset, RES).map((s) => s.angle);

  it('the averaged cage hits everywhere, matches the analytic normals and leaves no seam at the hard edges; split shading normals open seams (falsifier)', {
    timeout: 60000,
  }, () => {
    const averaged = run('averaged');
    const g = averaged.provenance.groups[0];
    // The automatic cage reaches the sphere corners (sqrt(3) - 1) r = 2.9 mm inside the low corners.
    expect(g?.maxRay).toBeGreaterThan((Math.sqrt(3) - 1) * R);
    expect(averaged.report.metrics.minGroupRayHitRatio).toBe(1);
    const errors = accuracy(averaged, true);
    expect(errors.length).toBe(frames.length);
    // Measured: mean 0.31, p95 0.32, max 1.9 degrees (8-bit RG quantization).
    expect(percentile(errors, 0.95)).toBeLessThan(0.5);
    expect(errors.reduce((a, b) => Math.max(a, b), 0)).toBeLessThan(3);
    const step = seams(averaged);
    expect(step.length).toBe(12 * 31);
    // Measured: mean 5.8, p95 6.2 degrees - the fillet's own gradient over one texel.
    expect(step.filter((a) => a > 10).length / step.length).toBeLessThanOrEqual(0.01);
    expect(mean(step)).toBeLessThan(8);
    const shading = seams(run('shading'));
    // Measured: mean 44.6 degrees, every sample above 10.
    expect(shading.filter((a) => a > 10).length / shading.length).toBeGreaterThan(0.05);
    expect(mean(shading)).toBeGreaterThan(20);
  });

  it('an explicit cage that ends inside the detail misses and warns; the automatic estimate does not (falsifier)', {
    timeout: 60000,
  }, () => {
    const short = run('averaged', { offset: 0.0002, maxRay: 0.001 });
    expect(short.report.metrics.minGroupRayHitRatio).toBeLessThan(0.99);
    expect(short.pass).toBe(false);
    expect(short.issues.map((i) => i.code)).toContain('ray-miss');
    expect(short.diagnostics.filter((d) => d.severity === 'warn')).toEqual([]);
    const auto = run('averaged');
    expect(auto.issues).toEqual([]);
    expect(auto.pass).toBe(true);
    // Against the full rays: the misses took the nearest point and lost the fillet.
    const wrong = (errors: number[]) => errors.filter((e) => e > 5).length / errors.length;
    expect(wrong(accuracy(auto, true))).toBe(0);
    // Measured: 0.2% of the texels (the fillet band) off by more than 5 degrees.
    expect(wrong(accuracy(short, true, auto))).toBeGreaterThan(0.001);
  });
});

describe('bake cage: a hard-rimmed cylinder (S3 golden finding, gate)', () => {
  it('side texels at the rim keep the side normal: cage rays that turn onto the cap defer to the base-normal ray; raw cage rays bake the cap (falsifier)', {
    timeout: 60000,
  }, () => {
    const RES = 128;
    const low = model();
    low.cylinder({ radiusTop: 0.4, radiusBottom: 0.4, height: 1, radialSegments: 12 });
    low.markSharp(sel.edges.dihedral('>', 40));
    low.uv.auto({ resolution: RES, padding: 4 });
    const high = model();
    high.cylinder({ radiusTop: 0.4, radiusBottom: 0.4, height: 1, radialSegments: 192 });
    const frames = texelFrames(surfaceOf(low, HARD), RES);
    const errors = (t: TextureAsset) =>
      frames.map((f) => {
        const v = texel(t, RES, f.x, f.y)
          .slice(0, 3)
          .map((c) => c * 2 - 1);
        const truth = Math.abs(f.n[1]) < 0.5 ? [f.p[0], 0, f.p[2]] : [0, Math.sign(f.p[1]), 0];
        return degrees(v, truth);
      });
    const options = {
      base: low,
      detail: high,
      maps: ['normalObject'] as const,
      resolution: RES,
      normals: HARD,
      detailNormals: HARD,
      filter: 'none' as const,
    };
    const fixed = errors(
      bake({ ...options, maps: [...options.maps] }).textures.normalObject as TextureAsset,
    );
    // Measured: max 0.37 degrees (split shading rays: the same).
    expect(Math.max(...fixed)).toBeLessThan(1);
    const sources = bakeSources({ ...options, maps: [...options.maps], key: 'rim' });
    if (!sources.ok) throw sources.error;
    const params = (sources.value['texture/rim-normalObject']?.source as { params: BakeJobParams })
      .params;
    const raw = runComputeJob(
      {
        kind: 'bake',
        inputs: [low.snapshot(), high.snapshot()],
        params: { ...params, rawCage: true },
      },
      tsBakeBackend,
    );
    if (!raw.ok) throw raw.error;
    const values = new Float32Array((raw.value.outputs[0] as Uint8Array).slice().buffer);
    const rawErrors = frames.map((f) => {
      const o = (f.y * RES + f.x) * 4;
      const v = [values[o] as number, values[o + 1] as number, values[o + 2] as number].map(
        (c) => c * 2 - 1,
      );
      const truth = Math.abs(f.n[1]) < 0.5 ? [f.p[0], 0, f.p[2]] : [0, Math.sign(f.p[1]), 0];
      return degrees(v, truth);
    });
    // Measured: 168 side texels at the rim take the cap normal (90 degrees).
    expect(rawErrors.filter((e) => e > 45).length).toBeGreaterThan(100);
  });
});

describe('bake cage estimate limits', () => {
  it('an automatic cage beyond 20% of the group diagonal is an error; an explicit cage bakes it', () => {
    const base = model();
    base.plane({ width: 0.2, height: 0.2 });
    base.uv.auto({ resolution: 16, padding: 1 });
    const detail = model();
    detail.plane({ width: 0.2, height: 0.2 });
    detail.translate(sel.all(), [0, 0, 0.08]);
    expect(bakeMaps({ base, detail, maps: ['height'], resolution: 16 })).toMatchObject({
      ok: false,
      error: { code: 'model-precondition', detail: { group: '' } },
    });
    const explicit = bake({
      base,
      detail,
      maps: ['height'],
      resolution: 16,
      cage: { offset: 0.1, maxRay: 0.2 },
    });
    expect(explicit.report.metrics.rayHitRatio).toBe(1);
  });
});

describe('bake direction: a floating bolt near a rounded plate edge (gate)', () => {
  const RES = 512;
  const BOLT = [0.08, 0] as const;
  const RADIUS = 0.006;
  const low = hardBox([0.2, 0.02, 0.2], RES);
  low.tag(sel.facing('+y', 10), 'top');
  const plate = model();
  plate.box({ size: [0.2, 0.02, 0.2] });
  plate.bevel(sel.edges.all(), { width: 0.008, segments: 8 });
  const bolt = model();
  bolt.cylinder({
    radiusTop: RADIUS,
    radiusBottom: RADIUS,
    height: 0.004,
    radialSegments: 48,
    center: [BOLT[0], 0.013, BOLT[1]],
  });
  bolt.assign(sel.all(), 'bolt');
  bolt.tag(sel.all(), 'floater');
  const high = model();
  high.append(plate);
  high.append(bolt);
  const surface = surfaceOf(low, HARD);
  const top = texelFrames(surface, RES).filter((f) => f.n[1] > 0.99);
  const texelSize = 0.2 / Math.sqrt(top.length);
  const run = (direction: BakeDirection, extra: Partial<BakeOptions> = {}) =>
    bake({
      base: low,
      detail: high,
      maps: ['normal', 'materialId'],
      resolution: RES,
      normals: HARD,
      detailNormals: { mode: 'weighted' },
      direction,
      filter: 'none',
      ...extra,
    });
  /** The bolt's footprint on the plate: centroid shift and radius error in texels. */
  const footprint = (r: ReturnType<typeof run>) => {
    const id = r.textures.materialId as TextureAsset;
    const inside = top.filter((f) => isSlot(id, RES, f, 1));
    const set = new Set(inside.map((f) => f.y * RES + f.x));
    const boundary = inside.filter((f) =>
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => !set.has((f.y + (dy as number)) * RES + f.x + (dx as number))),
    );
    const cx = mean(inside.map((f) => f.p[0]));
    const cz = mean(inside.map((f) => f.p[2]));
    return {
      shift: Math.hypot(cx - BOLT[0], cz - BOLT[1]) / texelSize,
      round:
        Math.max(
          ...boundary.map((f) => Math.abs(Math.hypot(f.p[0] - BOLT[0], f.p[2] - BOLT[1]) - RADIUS)),
        ) / texelSize,
    };
  };
  const seamOver10 = (r: ReturnType<typeof run>) => {
    const s = seamAngles(surface, r.textures.normal as TextureAsset, RES).map((a) => a.angle);
    return s.filter((a) => a > 10).length / s.length;
  };

  it("'face' keeps the bolt round and in place; the averaged cage skews it toward the edge (falsifier)", {
    timeout: 60000,
  }, () => {
    const face = footprint(run('face'));
    // Measured: shift 0.01, radius error 0.96 texels (the texel grid itself).
    expect(face.shift).toBeLessThanOrEqual(0.5);
    expect(face.round).toBeLessThanOrEqual(1);
    const averaged = footprint(run('averaged'));
    // Measured: shift 2.7, radius error 4.3 texels.
    expect(averaged.shift).toBeGreaterThan(2);
    expect(averaged.round).toBeGreaterThan(2);
  });

  it("{ blend } keeps both the bolt (face rays) and the rounded edges (cage rays); 'face' alone opens the edge seams (falsifier)", {
    timeout: 60000,
  }, () => {
    const blended = run({ blend: 0.01 });
    expect(blended.report.metrics.hardEdges).toBe(12);
    const b = footprint(blended);
    expect(b.shift).toBeLessThanOrEqual(0.5);
    expect(b.round).toBeLessThanOrEqual(1);
    // Measured: 0% of seam samples above 10 degrees with blend, 78% with 'face'.
    expect(seamOver10(blended)).toBeLessThanOrEqual(0.01);
    expect(seamOver10(run('face'))).toBeGreaterThan(0.5);
    // A face tag turns only the tagged top: its edges seam where the sides stay averaged.
    const tagged = run({ face: 'top' });
    expect(footprint(tagged).shift).toBeLessThanOrEqual(0.5);
    expect(seamOver10(tagged)).toBeGreaterThan(0.05);
  });

  it('floaters bake into the normal map only: no height and no occlusion under them; untagged they do both (falsifier)', {
    timeout: 60000,
  }, () => {
    const maps = ['height', 'ao'] as const;
    const extra = { maps: [...maps], ao: { rays: 16, distance: 0.02 } };
    const floating = run('face', { ...extra, tags: { floater: 'floater' } });
    const solid = run('face', extra);
    const under = top.filter((f) => Math.hypot(f.p[0] - BOLT[0], f.p[2] - BOLT[1]) < RADIUS * 0.8);
    const ring = top.filter((f) => {
      const d = Math.hypot(f.p[0] - BOLT[0], f.p[2] - BOLT[1]);
      return d > RADIUS * 1.1 && d < RADIUS * 1.5;
    });
    const height = (r: ReturnType<typeof run>) =>
      mean(under.map((f) => texel(r.textures.height as TextureAsset, RES, f.x, f.y)[0] as number));
    const ao = (r: ReturnType<typeof run>) =>
      mean(ring.map((f) => texel(r.textures.ao as TextureAsset, RES, f.x, f.y)[0] as number));
    expect(Math.abs(height(floating) - 0.5)).toBeLessThan(0.01);
    // Measured: 0.71 (the 5 mm bolt top over a height range of 11.6 mm).
    expect(height(solid)).toBeGreaterThan(0.65);
    expect(ao(floating)).toBe(1);
    expect(ao(solid)).toBeLessThan(0.9);
  });
});

describe('bake groups: two parts 5 mm apart (gate)', () => {
  const RES = 256;
  // Part A: a plate whose detail carries a tall knob (so its cage is 10 mm high). Part B: a
  // block with a flange reaching 27 mm over A, 6 mm above A's top.
  const low = model();
  low.box({ size: [0.0975, 0.02, 0.1], center: [-0.05125, 0, 0], tag: 'bake:a' });
  low.box({ size: [0.0975, 0.04, 0.1], center: [0.05125, 0.01, 0], tag: 'bake:b' });
  low.box({ size: [0.0325, 0.002, 0.06], center: [-0.01375, 0.017, 0], tag: 'bake:b' });
  low.markSharp(sel.edges.dihedral('>', 40));
  low.uv.auto({ resolution: RES, padding: 4 });
  const high = model();
  high.box({ size: [0.0975, 0.02, 0.1], center: [-0.05125, 0, 0], tag: 'bake:a' });
  high.box({ size: [0.01, 0.008, 0.01], center: [-0.08, 0.014, 0], tag: 'bake:a' });
  const b = model();
  b.box({ size: [0.0975, 0.04, 0.1], center: [0.05125, 0.01, 0] });
  b.box({ size: [0.0325, 0.002, 0.06], center: [-0.01375, 0.017, 0] });
  b.assign(sel.all(), 'b');
  b.tag(sel.all(), 'bake:b');
  high.append(b);
  const frames = texelFrames(surfaceOf(low), RES);
  const aTop = frames.filter(
    (f) => f.n[1] > 0.99 && f.p[0] < -0.003 && Math.abs(f.p[1] - 0.01) < 1e-4,
  );
  const under = aTop.filter((f) => f.p[0] > -0.03 && Math.abs(f.p[2]) < 0.03);
  const run = (extra: Partial<BakeOptions>) =>
    bake({
      base: low,
      detail: high,
      maps: ['materialId', 'ao'],
      resolution: RES,
      filter: 'none',
      ...extra,
      ao: { distance: 0.05, ...extra.ao },
    });
  const crossed = (r: ReturnType<typeof run>) =>
    aTop.filter((f) => isSlot(r.textures.materialId as TextureAsset, RES, f, 1)).length;
  const aoUnder = (r: ReturnType<typeof run>) =>
    mean(under.map((f) => texel(r.textures.ao as TextureAsset, RES, f.x, f.y)[0] as number));

  it("rays stay in their group: no texel of A shows B's flange; one shared group bakes it into A (falsifier)", {
    timeout: 60000,
  }, () => {
    const grouped = run({ tags: { groupPrefix: 'bake:' } });
    expect(grouped.provenance.groups.map((g) => g.id)).toEqual(['a', 'b']);
    for (const g of grouped.provenance.groups)
      expect(g.rayHits / g.samples).toBeGreaterThanOrEqual(0.99);
    expect(crossed(grouped)).toBe(0);
    const shared = run({});
    expect(shared.provenance.groups.map((g) => g.id)).toEqual(['']);
    // Measured: 725 of A's top texels show the flange.
    expect(crossed(shared)).toBeGreaterThan(100);
  });

  it("AO scope 'group' keeps B's shadow off A, 'all' casts it, 'exclude' removes B again (falsifier)", {
    timeout: 60000,
  }, () => {
    const tags = { groupPrefix: 'bake:' };
    // Measured: 0.91, 0.11, 0.91.
    expect(aoUnder(run({ tags }))).toBeGreaterThan(0.85);
    expect(aoUnder(run({ tags, ao: { scope: 'all' } }))).toBeLessThan(0.3);
    expect(aoUnder(run({ tags, ao: { scope: 'all', exclude: ['b'] } }))).toBeGreaterThan(0.85);
  });

  it('per-group settings override the bake-wide cage; the vertex target bakes per vertex and group', () => {
    const r = run({
      tags: { groupPrefix: 'bake:' },
      groups: { b: { cage: { offset: 0.003, maxRay: 0.006 } } },
    });
    expect(r.provenance.groups[1]).toMatchObject({ id: 'b', offset: 0.003, maxRay: 0.006 });
    expect(r.provenance.groups[0]?.offset).toBeGreaterThan(0.008);
    const vertex = bake({
      base: low,
      detail: high,
      maps: ['height'],
      target: 'vertex',
      tags: { groupPrefix: 'bake:' },
    });
    expect(vertex.provenance.groups.map((g) => g.samples)).toEqual([8, 16]);
  });

  it('a face in two groups and a base group without detail are preconditions', () => {
    const twice = model();
    twice.append(low);
    twice.tag(sel.tag('bake:a'), 'bake:b');
    expect(
      bakeMaps({
        base: twice,
        detail: high,
        maps: ['ao'],
        resolution: 32,
        tags: { groupPrefix: 'bake:' },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'model-precondition', detail: { input: 'base', groups: ['a', 'b'] } },
    });
    const onlyA = model();
    onlyA.box({ size: [0.0975, 0.02, 0.1], center: [-0.05125, 0, 0], tag: 'bake:a' });
    expect(
      bakeMaps({
        base: low,
        detail: onlyA,
        maps: ['ao'],
        resolution: 32,
        tags: { groupPrefix: 'bake:' },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'model-precondition', detail: { group: 'b' } },
    });
  });
});

describe('bake padding (U36, V4): mip-aware island spacing and a full gutter (gate)', () => {
  const atlas = (padding: { mips: number }, resolution: number) => {
    const m = model();
    for (let i = 0; i < 4; i++)
      m.box({ size: [0.05 + 0.01 * i, 0.03, 0.04], center: [i * 0.1, 0, 0] });
    m.cylinder({
      radiusTop: 0.02,
      radiusBottom: 0.02,
      height: 0.05,
      radialSegments: 24,
      center: [0.5, 0, 0],
    });
    m.markSharp(sel.edges.dihedral('>', 40));
    expect(m.uv.auto({ resolution, padding }).status).toBe('ok');
    return m;
  };

  it('1024 texels padded for mip 3 bleed into no 8 x 8 block; half the padding or a short gutter bleeds (falsifier)', {
    timeout: 60000,
  }, async () => {
    const executor = bakeWorkers({ workers: 4 });
    const run = async (options: BakeOptions) => {
      const result = await bakeMapsParallel(options, executor);
      if (!result.ok) throw result.error;
      return result.value;
    };
    expect(defaultProtectMip(1024)).toBe(3);
    expect(paddingTexels({ mips: 3 })).toBe(16);
    const base = atlas({ mips: 3 }, 1024);
    const r = await run({ base, detail: base, maps: ['normal'], resolution: 1024 });
    expect(r.report.metrics.protectMip).toBe(3);
    expect(r.provenance.bleed.slice(0, 3)).toEqual([0, 0, 0]);
    expect(r.report.metrics.protectedBleed).toBe(0);
    expect(r.issues).toEqual([]);
    const tight = atlas({ mips: 2 }, 1024);
    const bleeding = await run({ base: tight, detail: tight, maps: ['normal'], resolution: 1024 });
    expect(bleeding.provenance.bleed[2]).toBeGreaterThan(0);
    expect(bleeding.issues.find((i) => i.code === 'mip-bleed')?.detail).toMatchObject({
      protectMip: 3,
    });
    const short = await run({ base, detail: base, maps: ['normal'], resolution: 1024, gutter: 4 });
    expect(short.provenance.bleed[2]).toBeGreaterThan(0);
  });

  it('defaults protect down to 128 texels; malformed mip padding is an invalid argument', () => {
    expect([64, 128, 256, 512, 2048].map(defaultProtectMip)).toEqual([0, 0, 1, 2, 4]);
    expect(Number.isNaN(paddingTexels({ mips: 1.5 }))).toBe(true);
    const m = model();
    m.box({ size: [0.1, 0.1, 0.1] });
    expect(m.uv.auto({ resolution: 64, padding: { mips: -1 } }).status).toBe('failed');
  });
});
