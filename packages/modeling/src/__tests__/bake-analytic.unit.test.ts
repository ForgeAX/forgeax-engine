import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type BakeExecutor, type BakeOptions, bakeMaps, bakeMapsParallel } from '../bake';
import { type AnalyticRules, normalStep, solveRay } from '../compute/bake-analytic';
import { bakePhases } from '../compute/bake-ts';
import { type AnalyticPatch, WorkMeter } from '../compute/job';
import { model } from '../model';
import { nurbs } from '../nurbs';
import { sel } from '../selectors';
import {
  bake,
  bicubicBump,
  cylinderQuarter,
  digestOf,
  fillUv1,
  patchModel,
  rectangle,
  type Scene,
  scene,
  sphereZone,
  textureBytes,
} from './bake-analytic-fixtures';
import { degrees, norm, surfaceOf, texel, texelFrames } from './bake-gates';

/**
 * BK63 gates: the analytic bake answers position, normal and height from the exact patches
 * where the base carries the patch domain, agrees with the ray bake within the tessellation
 * tolerance, falls back to rays (counted, fail-closed) everywhere else, and a verifier mutation
 * set shows a wrong patch never reaches the output.
 */

const RES = 128;
const MAPS = ['position', 'normal', 'normalObject', 'height'] as const;

function options(s: Scene, extra: Partial<BakeOptions> = {}): BakeOptions {
  return { base: s.base, detail: s.detail, maps: [...MAPS], resolution: RES, ...extra };
}

const analyticOf = (r: ReturnType<typeof bake>) => {
  const a = r.provenance.analytic;
  if (a === undefined) throw new Error('no analytic report');
  return a;
};

describe('analytic bake: agreement with the ray bake (gate)', () => {
  const cases = [
    ['sphere zone', sphereZone(0.5, 0, 1.0)],
    ['cylinder', cylinderQuarter(0.3, 0.4)],
    ['bicubic bump', bicubicBump(0, 0.6, 0.15)],
  ] as const;
  for (const [name, surface] of cases) {
    it(`${name}: every verified texel is within the tolerance and the patch answers > 90 % (verify all)`, {
      timeout: 120000,
    }, () => {
      const r = bake(options(scene(surface), { analytic: { verify: 'all' } }));
      const a = analyticOf(r);
      expect(a.mismatches).toEqual([]);
      expect(r.issues.map((i) => i.code)).not.toContain('analytic-mismatch');
      for (const m of a.maps) {
        expect(m.verified).toBeGreaterThan(100);
        expect(m.max).toBeLessThanOrEqual(m.tolerance);
        expect(m.p99).toBeLessThanOrEqual(m.max);
      }
      expect(a.maps.map((m) => m.map).sort()).toEqual(['height', 'normal', 'position']);
      expect(a.analyticSamples / (a.analyticSamples + a.raySamples)).toBeGreaterThan(0.9);
      expect(a.groups).toEqual([
        expect.objectContaining({ id: '', patches: ['p'], analytic: true }),
      ]);
      expect(r.diagnostics.some((d) => d.message.startsWith('analytic bake:'))).toBe(true);
    });
  }

  it('a reversed parametrization (transposed, flipped) bakes the same outward normals', {
    timeout: 120000,
  }, () => {
    const surface = sphereZone(0.5, 0, 1.0);
    for (const reversed of [scene(nurbs.transpose(surface)), scene(surface, { flip: true })]) {
      const r = bake(options(reversed, { analytic: { verify: 'all' } }));
      expect(analyticOf(r).mismatches).toEqual([]);
      expect(analyticOf(r).analyticSamples).toBeGreaterThan(1000);
      const a = analyticOf(r);
      for (const m of a.maps) expect(m.max).toBeLessThanOrEqual(m.tolerance);
    }
  });
});

describe('analytic bake: exact where the ray bake sees the tessellation (gate)', () => {
  const R = 0.5;
  it('on a coarse sphere the exact position and normal are within one encoded step of the closed form; the ray bake is not', {
    timeout: 120000,
  }, () => {
    const coarse = { chord: 0.05, angle: 40 };
    const s = scene(sphereZone(R, 0, 1.0), { detail: coarse, base: { chord: 0.05, angle: 40 } });
    const common = {
      ...options(s, { maps: ['position', 'normalObject'] }),
      samples: 1 as const,
      mips: false,
      // The exact sphere stands up to the chord outside the coarse base: the cage must reach it.
      cage: { offset: 0.06, maxRay: 0.12 },
    };
    const exact = bake({ ...common, analytic: { verify: 'sample' } });
    const rays = bake(common);
    expect(analyticOf(exact).mismatches).toEqual([]);
    const { min, max } = exact.provenance.positionBounds;
    const step = Math.max(...[0, 1, 2].map((c) => (max[c] as number) - (min[c] as number))) / 255;
    const frames = texelFrames(surfaceOf(s.base), RES);
    const errors = (r: ReturnType<typeof bake>) => {
      const radius: number[] = [];
      const angle: number[] = [];
      for (const f of frames) {
        const p = texel(r.textures.position as TextureAsset, RES, f.x, f.y);
        const decoded = [0, 1, 2].map(
          (c) => (min[c] as number) + (p[c] as number) * ((max[c] as number) - (min[c] as number)),
        );
        radius.push(Math.abs(Math.hypot(...(decoded as [number, number, number])) - R));
        const n = texel(r.textures.normalObject as TextureAsset, RES, f.x, f.y).map(
          (v) => v * 2 - 1,
        );
        angle.push(degrees(n, decoded));
      }
      const q = (v: number[], f: number) =>
        [...v].sort((x, y) => x - y)[Math.floor(f * (v.length - 1))] as number;
      return { radius: q(radius, 0.9), angle: q(angle, 0.9) };
    };
    expect(frames.length).toBeGreaterThan(500);
    const e = errors(exact);
    const o = errors(rays);
    expect(e.radius).toBeLessThan(step);
    expect(e.angle).toBeLessThan(1.5);
    expect(o.radius).toBeGreaterThan(3 * step);
    expect(o.angle).toBeGreaterThan(5);
  });
});

describe('analytic bake: a wrong patch never reaches the output (mutation set)', () => {
  const surface = sphereZone(0.5, 0, 1.0);
  const patchOf = (s: typeof surface): AnalyticPatch => ({
    kind: 'nurbs',
    name: 'p',
    surface: s,
    chord: 0.001,
    angle: 12,
  });

  it('a patch offset by three tolerances is caught by the verifier, named, and the group is ray-baked', {
    timeout: 120000,
  }, () => {
    const s = scene(surface);
    const honest = bake(options(s, { analytic: { verify: 'all' } }));
    const tolerance = analyticOf(honest).maps.find((m) => m.map === 'height')?.tolerance as number;
    const offset = 3 * tolerance;
    // The domain channel feeds the stale-descriptor guard, which would refuse this patch first (audit 7); without it
    // the verifier is the only defence, which is what this test exercises.
    s.detail.editMesh.channels.delete('uv1');
    const wrong = patchOf(sphereZone(0.5 + offset, 0, 1.0));
    const caught = bake(options(s, { analytic: { verify: 'sample', patches: [wrong] } }));
    const a = analyticOf(caught);
    expect(a.mismatches.length).toBeGreaterThan(0);
    expect(a.mismatches.every((m) => m.patch === 'p' && m.worst > m.tolerance)).toBe(true);
    expect(a.groups[0]).toEqual(
      expect.objectContaining({ analytic: false, reason: 'mismatch', analyticSamples: 0 }),
    );
    const issue = caught.issues.find((i) => i.code === 'analytic-mismatch');
    expect(issue?.severity).toBe('warn');
    expect(issue?.detail).toEqual(expect.objectContaining({ subject: 'p' }));
    expect(caught.pass).toBe(false);
    const rays = bake(options(s));
    expect(textureBytes(caught)).toEqual(textureBytes(rays));
    // Falsifier: unverified, the wrong patch is written out and the bytes differ.
    const trusted = bake(options(s, { analytic: { verify: 'off', patches: [wrong] } }));
    expect(analyticOf(trusted).mismatches).toEqual([]);
    expect(textureBytes(trusted)).not.toEqual(textureBytes(rays));
  });

  const rules: AnalyticRules = { lo: -0.02, hi: 0, facingMin: 0.1, residual: 1e-9 };
  const patch = patchOf(sphereZone(0.5, 0.2, 1.2));
  const origin: [number, number, number] = [0.3, 0.3, 0.4];

  it('the solve turns the patch normal to the base side; without that orientation a reversed patch reads inward (falsifier)', () => {
    const outside = norm(origin);
    // P sits 0.01 m outside the sphere (R 0.5); c is the outward cage direction, the detail lies behind P.
    const start = outside.map((x) => x * 0.51) as [number, number, number];
    const reversed = patchOf(nurbs.transpose(sphereZone(0.5, 0.2, 1.2)));
    const along = (v: readonly number[] | undefined) =>
      (v?.[0] ?? 0) * outside[0] + (v?.[1] ?? 0) * outside[1] + (v?.[2] ?? 0) * outside[2];
    const flipped = solveRay(reversed, [0.55, 0.5], start, outside, outside, outside, rules, false);
    expect(flipped).toBeDefined();
    expect(along(flipped?.normal)).toBeGreaterThan(0.99);
    expect(flipped?.height).toBeCloseTo(-0.01, 6);
    // Without the base side the reversed patch's own normal points inward and the facing rule refuses it.
    expect(
      solveRay(reversed, [0.55, 0.5], start, outside, outside, undefined, rules, false),
    ).toBeUndefined();
    expect(
      along(solveRay(patch, [0.5, 0.55], start, outside, outside, outside, rules, false)?.normal),
    ).toBeGreaterThan(0.99);
  });

  it('the cage span rejects a hit beyond the ray reach; an unbounded span would accept it (falsifier)', () => {
    const side = norm(origin);
    const start = side.map((x) => x * 0.56) as [number, number, number];
    const near = solveRay(patch, [0.5, 0.55], start, side, side, side, rules, false);
    // The patch lies 0.06 m behind P; the cage reaches 0.02 m.
    expect(near).toBeUndefined();
    const unbounded = solveRay(
      patch,
      [0.5, 0.55],
      start,
      side,
      side,
      side,
      { ...rules, lo: Number.NEGATIVE_INFINITY, hi: Number.POSITIVE_INFINITY },
      false,
    );
    expect(unbounded?.height).toBeCloseTo(-0.06, 6);
    expect(normalStep()).toBeCloseTo(0.4498, 3);
  });
});

describe('analytic bake: coverage and fail-closed fallbacks (gate)', () => {
  it('a base part without the domain is ray-baked and its texels equal the ray-only bake', {
    timeout: 120000,
  }, () => {
    const sphere = sphereZone(0.4, 0, 1.0);
    const plane = rectangle(2, 0.4, 0.4);
    const detail = model();
    detail.surface({
      patches: [
        { surface: sphere, name: 'sph' },
        { surface: plane, name: 'pl' },
      ],
      chord: 0.001,
      angle: 12,
    });
    const base = model();
    base.surface({ patches: [{ surface: sphere, name: 'sph' }], chord: 0.03, angle: 30 });
    const flat = model();
    flat.plane({ width: 0.4, height: 0.4 });
    flat.translate(sel.all(), [2, 0, 0]);
    fillUv1(flat);
    base.append(flat);
    base.uv.auto({ resolution: RES, padding: 2 });
    const common: BakeOptions = {
      base,
      detail,
      maps: [...MAPS],
      resolution: RES,
      samples: 1 as const,
      mips: false,
    };
    const mixed = bake({ ...common, analytic: { verify: 'sample' } });
    const rays = bake(common);
    const a = analyticOf(mixed);
    expect(a.analyticSamples).toBeGreaterThan(500);
    expect(a.raySamples).toBeGreaterThan(500);
    expect(a.mismatches).toEqual([]);
    const frames = texelFrames(surfaceOf(base), RES);
    const plain = frames.filter((f) => f.p[0] > 1.5);
    expect(plain.length).toBeGreaterThan(500);
    for (const map of MAPS) {
      const x = mixed.textures[map] as TextureAsset;
      const y = rays.textures[map] as TextureAsset;
      for (const f of plain) {
        expect(texel(x, RES, f.x, f.y), `${map} ${f.x},${f.y}`).toEqual(texel(y, RES, f.x, f.y));
      }
    }
    // The sphere part is exact: it differs from the tessellated ray bake somewhere.
    expect(textureBytes(mixed)).not.toEqual(textureBytes(rays));
  });

  it('an untagged detail face, a wrap period, ray-only maps and a bytes detail ray-bake the group, counted', {
    timeout: 240000,
  }, () => {
    const s = scene(sphereZone(0.5, 0, 1.0));
    const plain = {
      ...options(s),
      samples: 1 as const,
      mips: false,
      cage: { offset: 0.03, maxRay: 0.06 },
    };
    const rays = bake(plain);
    const reasonOf = (r: ReturnType<typeof bake>) => analyticOf(r).groups[0]?.reason;

    const stray = model();
    stray.surface({
      patches: [{ surface: sphereZone(0.5, 0, 1.0), name: 'p' }],
      chord: 0.001,
      angle: 12,
    });
    stray.box({ size: [0.05, 0.05, 0.05], center: [0.3, 0.3, 0.9] });
    fillUv1(stray);
    const strayed = { ...plain, detail: stray };
    const strayRays = bake(strayed);
    const strayAnalytic = bake({ ...strayed, analytic: true });
    expect(reasonOf(strayAnalytic)).toBe('detail-not-patches');
    expect(analyticOf(strayAnalytic).analyticSamples).toBe(0);
    expect(textureBytes(strayAnalytic)).toEqual(textureBytes(strayRays));

    const tiled = bake({ ...plain, wrap: { u: [4, 0, 0] }, analytic: true });
    expect(reasonOf(tiled)).toBe('tiled-detail');
    expect(analyticOf(tiled).analyticSamples).toBe(0);
    expect(textureBytes(tiled)).toEqual(textureBytes(bake({ ...plain, wrap: { u: [4, 0, 0] } })));

    const rayOnly = { ...plain, maps: ['ao', 'curvature'] as const, ao: { rays: 8 } };
    const aoRays = bake({ ...rayOnly, maps: [...rayOnly.maps] });
    const aoAnalytic = bake({ ...rayOnly, maps: [...rayOnly.maps], analytic: true });
    expect(textureBytes(aoAnalytic)).toEqual(textureBytes(aoRays));
    expect(aoAnalytic.diagnostics.map((d) => d.message).join('\n')).toContain(
      'no requested map is analytic',
    );

    const bytes = bake({ ...plain, detail: s.detail.snapshot(), analytic: true });
    expect(bytes.provenance.analytic).toBeUndefined();
    expect(textureBytes(bytes)).toEqual(textureBytes(rays));
    expect(bytes.diagnostics.map((d) => d.message).join('\n')).toContain('bytes detail');

    const vertex = bake({
      ...plain,
      target: 'vertex',
      maps: ['normalObject'],
      analytic: true,
    });
    expect(vertex.provenance.analytic).toBeUndefined();
    expect(vertex.diagnostics.map((d) => d.message).join('\n')).toContain('vertex target');
  });

  it('a mixed analytic and ray map set keeps the ray maps byte-identical', {
    timeout: 120000,
  }, () => {
    const s = scene(sphereZone(0.5, 0, 1.0));
    const common = {
      ...options(s, { maps: ['position', 'ao', 'curvature'] }),
      samples: 1 as const,
      mips: false,
      ao: { rays: 8 },
    };
    const mixed = bake({ ...common, analytic: { verify: 'sample' } });
    const rays = bake(common);
    expect(Buffer.compare(textureBytes(mixed).ao as Buffer, textureBytes(rays).ao as Buffer)).toBe(
      0,
    );
    expect(
      Buffer.compare(
        textureBytes(mixed).curvature as Buffer,
        textureBytes(rays).curvature as Buffer,
      ),
    ).toBe(0);
    expect(analyticOf(mixed).analyticSamples).toBeGreaterThan(1000);
  });
});

describe('analytic bake: default off and determinism (gate)', () => {
  it('the default ray bake equals the digest recorded before the analytic bake existed (refreshed when the per-group branch counters joined provenance; texture bytes unchanged)', {
    timeout: 120000,
  }, () => {
    const s = scene(sphereZone(0.5, 0, 1.0));
    const r = bake({
      base: s.base,
      detail: s.detail,
      maps: ['position', 'normal', 'normalObject', 'height', 'ao', 'curvature'],
      resolution: 128,
      samples: 4,
      ao: { rays: 8 },
    });
    expect(r.provenance.analytic).toBeUndefined();
    expect(digestOf(r)).toBe('ebc05b8404b67aa95ce658f06768b98b198c5721325ae5042f6985f14f1fd0e8');
    expect(r.diagnostics.some((d) => d.message.includes('analytic'))).toBe(false);
  });

  it('is deterministic, and bakeMapsParallel in any split equals the in-place bake', {
    timeout: 240000,
  }, async () => {
    const s = scene(sphereZone(0.5, 0, 1.0));
    const opts = options(s, { analytic: { verify: 'sample' }, samples: 4, mips: false });
    const first = bake(opts);
    const again = bake(opts);
    expect(digestOf(again)).toBe(digestOf(first));
    const inProcess =
      (order: (rows: readonly number[]) => number[][]): BakeExecutor =>
      async (request, rows, { budget }) => {
        const prepared = bakePhases.prepare(request, new WorkMeter(Number.POSITIVE_INFINITY));
        if (!prepared.ok) throw prepared.error;
        const parts = [];
        let work = 0;
        for (const chunk of order(rows)) {
          const meter = new WorkMeter(budget);
          const part = bakePhases.rows(prepared.value, chunk, meter);
          if (!part.ok) throw part.error;
          parts.push(part.value);
          work += meter.units;
        }
        return { ok: true, parts, work };
      };
    for (const order of [
      (rows: readonly number[]) => [[...rows]],
      (rows: readonly number[]) => [...rows].reverse().map((r) => [r]),
      (rows: readonly number[]) => [
        rows.filter((r) => r % 3 === 1),
        rows.filter((r) => r % 3 !== 1).reverse(),
      ],
    ]) {
      const split = await bakeMapsParallel(opts, inProcess(order));
      if (!split.ok) throw split.error;
      expect(digestOf(split.value)).toBe(digestOf(first));
      expect(split.value.provenance.analytic).toEqual(first.provenance.analytic);
    }
    const direct = bakeMaps(opts);
    expect(direct.ok).toBe(true);
  });

  it('rejects misspelt analytic options and a bad verify mode', () => {
    const s = scene(sphereZone(0.5, 0, 1.0));
    const typo = bakeMaps(options(s, { analytic: { verfy: 'all' } as never }));
    expect(typo.ok).toBe(false);
    const bad = bakeMaps(options(s, { analytic: { verify: 'most' as never } }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('model-invalid-argument');
    expect(patchModel).toBeDefined();
  });
});
