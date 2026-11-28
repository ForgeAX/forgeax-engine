import { describe, expect, it } from 'vitest';
import type { BakeOptions } from '../bake';
import {
  type AnalyticPlan,
  type AnalyticRules,
  allowed,
  angleBetween,
  guardPatches,
  normalAt,
  normalStep,
  solveRay,
  solveSample,
  stratifiedSamples,
} from '../compute/bake-analytic';
import type { AnalyticPatch } from '../compute/job';
import { model } from '../model';
import { sel } from '../selectors';
import {
  bake,
  fillUv1,
  patchModel,
  rectangle,
  type Scene,
  scene,
  sphereZone,
  textureBytes,
} from './bake-analytic-fixtures';
import { norm } from './bake-gates';

/**
 * BK63 audit gates (Audit 7): the default verifier, the stale-descriptor guard, the measured
 * normal tolerance, and the unit gates of the solve and the sample plan that the mutation set
 * `uv2-bk63-analytic` relies on.
 */

const RES = 64;
const MAPS = ['position', 'normal', 'normalObject', 'height'] as const;

function plain(s: Scene, extra: Partial<BakeOptions> = {}): BakeOptions {
  return {
    base: s.base,
    detail: s.detail,
    maps: [...MAPS],
    resolution: RES,
    samples: 1,
    mips: false,
    cage: { offset: 0.03, maxRay: 0.06 },
    ...extra,
  };
}

const analyticOf = (r: ReturnType<typeof bake>) => {
  const a = r.provenance.analytic;
  if (a === undefined) throw new Error('no analytic report');
  return a;
};

const patchOf = (
  surface: AnalyticPatch['surface'],
  tessellation = { chord: 0.001, angle: 12 },
  name = 'p',
): AnalyticPatch => ({ kind: 'nurbs', name, surface, ...tessellation });

describe('analytic bake: the default verifier is every sub-sample (audit 7, item 2)', () => {
  it('analytic: true and an options object without verify verify all; sample and off stay explicit', {
    timeout: 120000,
  }, () => {
    const s = scene(sphereZone(0.5, 0, 1.0), { resolution: RES });
    const byDefault = bake(plain(s, { analytic: true }));
    const object = bake(plain(s, { analytic: {} }));
    const sample = bake(plain(s, { analytic: { verify: 'sample' } }));
    const off = bake(plain(s, { analytic: { verify: 'off' } }));
    expect(analyticOf(byDefault).verify).toBe('all');
    expect(analyticOf(object).verify).toBe('all');
    expect(analyticOf(sample).verify).toBe('sample');
    expect(analyticOf(off).verify).toBe('off');
    expect(analyticOf(off).maps.every((m) => m.verified === 0)).toBe(true);
    // 'all' compares every analytic sub-sample; 'sample' at most 256 per group.
    expect(analyticOf(sample).groups[0]?.verified).toBeLessThanOrEqual(256);
    expect(analyticOf(byDefault).groups[0]?.verified).toBeGreaterThan(1000);
    expect(textureBytes(byDefault)).toEqual(textureBytes(object));
  });
});

describe('analytic bake: a stale descriptor is refused whatever the verifier (audit 7, item 3)', () => {
  const surface = sphereZone(0.5, 0, 1.0);
  const moved = (how: 'translate' | 'scale', by: number) => {
    const s = scene(surface, { resolution: RES });
    if (how === 'translate') s.detail.translate(sel.all(), [by, 0, 0]);
    else s.detail.scale(sel.all(), [by, by, by], [0, 0, 0]);
    return s;
  };

  it('an honest detail is guarded and stays exact; a move inside the chord is not stale', {
    timeout: 120000,
  }, () => {
    const honest = bake(
      plain(scene(surface, { resolution: RES }), { analytic: { verify: 'off' } }),
    );
    const a = analyticOf(honest);
    expect(a.groups[0]?.guarded).toBeGreaterThan(100);
    expect(a.groups[0]).toEqual(expect.objectContaining({ analytic: true }));
    expect(a.groups[0]?.reason).toBeUndefined();
    expect(a.mismatches).toEqual([]);
    const within = bake(plain(moved('translate', 0.0004), { analytic: { verify: 'off' } }));
    expect(analyticOf(within).groups[0]?.reason).toBeUndefined();
  });

  for (const [how, by] of [
    ['translate', 0.005],
    ['scale', 1.02],
  ] as const) {
    it(`a ${how} of the detail ray-bakes the group with verify off, counted and named`, {
      timeout: 120000,
    }, () => {
      const s = moved(how, by);
      const rays = bake(plain(s));
      const stale = bake(plain(s, { analytic: { verify: 'off' } }));
      const a = analyticOf(stale);
      expect(a.groups[0]).toEqual(
        expect.objectContaining({ analytic: false, reason: 'detail-moved', analyticSamples: 0 }),
      );
      expect(a.mismatches).toEqual([
        expect.objectContaining({ patch: 'p', map: 'position', tolerance: 0.001 }),
      ]);
      expect(a.mismatches[0]?.worst).toBeGreaterThan(0.001);
      expect(a.mismatches[0]?.count).toBeGreaterThan(0);
      expect(stale.issues.find((i) => i.code === 'analytic-mismatch')?.severity).toBe('warn');
      expect(textureBytes(stale)).toEqual(textureBytes(rays));
      expect(analyticOf(bake(plain(s, { analytic: true }))).groups[0]?.reason).toBe('detail-moved');
    });
  }

  it('without the guard (the detail carries no domain channel) the stale patch is written out (falsifier)', {
    timeout: 120000,
  }, () => {
    const s = moved('translate', 0.005);
    s.detail.editMesh.channels.delete('uv1');
    const rays = bake(plain(s));
    const trusted = bake(plain(s, { analytic: { verify: 'off' } }));
    const a = analyticOf(trusted);
    expect(a.groups[0]).toEqual(expect.objectContaining({ analytic: true, guarded: 0 }));
    expect(a.analyticSamples).toBeGreaterThan(1000);
    expect(textureBytes(trusted)).not.toEqual(textureBytes(rays));
    // The verifier is the other net: with it on, the same detail is caught and ray-baked.
    const verified = bake(plain(s, { analytic: { verify: 'all' } }));
    expect(analyticOf(verified).groups[0]?.reason).toBe('mismatch');
    expect(textureBytes(verified)).toEqual(textureBytes(rays));
  });
});

describe('analytic bake: the normal tolerance follows the detail tessellation (audit 7, item 4)', () => {
  it('an honest fine detail passes with a tolerance a third of the recorded angle', {
    timeout: 120000,
  }, () => {
    const s = scene(sphereZone(0.5, 0, 1.0), { resolution: RES });
    const a = analyticOf(bake(plain(s, { analytic: { verify: 'all' } })));
    const normal = a.maps.find((m) => m.map === 'normal');
    expect(a.mismatches).toEqual([]);
    expect(normal?.max).toBeGreaterThan(0.5);
    expect(normal?.max).toBeLessThanOrEqual(normal?.tolerance as number);
    // The honest deviation stays below half the tolerance: the margin is documented, not slack.
    expect((normal?.tolerance as number) / (normal?.max as number)).toBeLessThan(3);
    expect(normal?.tolerance).toBeLessThan(5);
  });

  const tilt = (degrees: number) => {
    const a = (degrees * Math.PI) / 180;
    const flat = rectangle(0, 0.1, 0.1);
    return {
      ...flat,
      points: flat.points.map((row) =>
        row.map((q): [number, number, number] => [q[0] * Math.cos(a), q[1], q[0] * Math.sin(a)]),
      ),
    };
  };
  const plane = () => {
    const s = scene(rectangle(0, 0.1, 0.1), {
      detail: { chord: 0.01, angle: 12 },
      base: { chord: 0.01, angle: 12 },
      resolution: RES,
    });
    return { s, options: plain(s, { cage: { offset: 0.02, maxRay: 0.04 } }) };
  };

  it('an 8 degree normal error with positions inside the chord is caught, named as a normal mismatch', {
    timeout: 120000,
  }, () => {
    const { s, options } = plane();
    const right = bake({ ...options, analytic: { verify: 'all' } });
    expect(analyticOf(right).mismatches).toEqual([]);
    const wrong = bake({
      ...options,
      analytic: { verify: 'all', patches: [patchOf(tilt(8), { chord: 0.01, angle: 12 })] },
    });
    const a = analyticOf(wrong);
    expect(a.mismatches.map((m) => m.map)).toEqual(['normal']);
    expect(a.mismatches[0]?.worst).toBeGreaterThan(7);
    expect(a.mismatches[0]?.tolerance).toBeLessThan(1);
    expect(a.groups[0]?.reason).toBe('mismatch');
    expect(textureBytes(wrong)).toEqual(textureBytes(bake({ ...options, detail: s.detail })));
  });

  it('a detail without the domain channel has no measured turn: the recorded angle bounds it (documented limit, falsifier)', {
    timeout: 120000,
  }, () => {
    const { s, options } = plane();
    s.detail.editMesh.channels.delete('uv1');
    const loose = bake({
      ...options,
      analytic: { verify: 'all', patches: [patchOf(tilt(8), { chord: 0.01, angle: 12 })] },
    });
    expect(analyticOf(loose).mismatches).toEqual([]);
    expect(analyticOf(loose).groups[0]?.analytic).toBe(true);
    const declared = bake({
      ...options,
      analytic: { verify: 'all', patches: [patchOf(tilt(8), { chord: 0.01, angle: 4 })] },
    });
    expect(analyticOf(declared).mismatches.map((m) => m.map)).toEqual(['normal']);
  });
});

describe('analytic bake: sample counts and metrics (audit 7, item 5)', () => {
  it('metrics.samples counts ray samples only; analyticSamples completes the total', {
    timeout: 120000,
  }, () => {
    const s = scene(sphereZone(0.5, 0, 1.0), { resolution: RES });
    const rays = bake(plain(s));
    const exact = bake(plain(s, { analytic: { verify: 'off' } }));
    const a = analyticOf(exact);
    expect(exact.report.metrics.analyticSamples).toBe(a.analyticSamples);
    expect(rays.report.metrics.analyticSamples).toBeUndefined();
    expect(a.analyticSamples).toBeGreaterThan(0);
    expect(exact.report.metrics.samples).toBe(a.raySamples);
    expect((exact.report.metrics.samples as number) + a.analyticSamples).toBe(
      rays.report.metrics.samples,
    );
  });
});

describe('analytic bake: the solve and the sample plan (unit gates)', () => {
  const rules: AnalyticRules = { lo: -0.1, hi: 0.1, facingMin: -1, residual: 1e-9 };
  const sphere = (r: number) => patchOf(sphereZone(r, 0.2, 1.2));
  const from = norm([0.3, 0.3, 0.4]);

  it('a ray that misses the patch is refused, not clamped onto its boundary (falsifier: an unchecked residual accepts it)', () => {
    const away: [number, number, number] = [from[0] * 0.55 + 0.9, from[1] * 0.55, from[2] * 0.55];
    const hit: [number, number, number] = [from[0] * 0.55, from[1] * 0.55, from[2] * 0.55];
    const inward: [number, number, number] = [-from[0], -from[1], -from[2]];
    const loose = { ...rules, lo: -10, hi: 10, facingMin: -2 };
    expect(
      solveRay(sphere(0.5), [0.5, 0.5], hit, inward, inward, undefined, loose, false),
    ).toBeDefined();
    expect(
      solveRay(sphere(0.5), [0.5, 0.5], away, inward, inward, undefined, loose, false),
    ).toBeUndefined();
  });

  it('the own-side cosine refuses a hit seen from another side under an averaged cage ray', () => {
    const start = from.map((x) => x * 0.51) as [number, number, number];
    const side = from;
    const own = { ...rules, facingMin: 0.1, ownSideCos: 0.5 };
    const sideways = norm([from[0], from[1], from[2] - 1.2]);
    const near = solveRay(sphere(0.5), [0.5, 0.55], start, side, sideways, side, own, true);
    expect(near).toBeUndefined();
    expect(
      solveRay(sphere(0.5), [0.5, 0.55], start, side, sideways, side, own, false),
    ).toBeDefined();
    expect(solveRay(sphere(0.5), [0.5, 0.55], start, side, from, side, own, true)).toBeDefined();
  });

  it('the nearest accepted candidate answers, whatever the candidate order', () => {
    const outer = sphere(0.5);
    const inner = sphere(0.52);
    for (const patches of [
      [outer, inner],
      [inner, outer],
    ] as const) {
      const plan = {
        patches,
        start: Int32Array.of(0, 2),
        candidate: Int32Array.of(0, 1),
        domain: Float64Array.of(0.5, 0.5, 0.5, 0.5, 0.5, 0.5),
      } as unknown as AnalyticPlan;
      const p = from.map((x) => x * 0.53) as [number, number, number];
      const solved = solveSample(
        plan,
        0,
        [1, 0, 0],
        p,
        from.map((x) => -x) as [number, number, number],
        from,
        from,
        rules,
        false,
      );
      // The ray goes inward from 0.53: radius 0.52 is 0.01 away, radius 0.5 is 0.03 away.
      expect(solved?.height).toBeCloseTo(0.01, 6);
      expect(patches[solved?.patch as number]).toBe(inner);
    }
  });

  it('stratified samples follow the areas: a large triangle gets proportionally more points, all inside their triangle', () => {
    const areas = [1, 1, 8];
    const points = stratifiedSamples(areas, 100);
    const counts = [0, 0, 0];
    for (const { index, w } of points) {
      counts[index] = (counts[index] as number) + 1;
      expect(Math.min(...w)).toBeGreaterThanOrEqual(0);
      expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 12);
    }
    expect(counts).toEqual([10, 10, 80]);
    expect(stratifiedSamples(areas, 100)).toEqual(points);
    expect(stratifiedSamples([0, 0], 10)).toEqual([]);
  });
});

describe('analytic bake: coverage plan and verifier reach (gates)', () => {
  it('a floater tagged with a patch name still sends its group to rays (falsifier: patch tags alone describe it)', {
    timeout: 120000,
  }, () => {
    const s = scene(sphereZone(0.5, 0, 1.0), { resolution: RES });
    const bolt = model();
    bolt.box({ size: [0.05, 0.05, 0.05], center: [0.3, 0.3, 0.9] });
    bolt.tag(sel.all(), 'p');
    bolt.tag(sel.all(), 'floater');
    fillUv1(bolt);
    s.detail.append(bolt);
    const options = plain(s, { tags: { floater: 'floater' } });
    const a = analyticOf(bake({ ...options, analytic: { verify: 'off' } }));
    expect(a.groups[0]?.reason).toBe('detail-not-patches');
    expect(a.analyticSamples).toBe(0);
  });

  it('the default sample verifier catches a localized patch error; a sparser one would miss it', {
    timeout: 240000,
  }, () => {
    const surface = sphereZone(0.5, 0, 1.0);
    const s = scene(surface, { resolution: RES });
    // Unguarded (no domain channel on the detail): the verifier alone has to find the error.
    s.detail.editMesh.channels.delete('uv1');
    const corner = surface.points[0]?.[0] as [number, number, number];
    const bent = {
      ...surface,
      points: surface.points.map((row, i) =>
        row.map((q, j): [number, number, number] =>
          i === 0 && j === 0 ? [corner[0] * 1.1, corner[1] * 1.1, corner[2] * 1.1] : [...q],
        ),
      ),
    };
    for (const verify of ['sample', 'all'] as const) {
      const r = bake(plain(s, { analytic: { verify, patches: [patchOf(bent)] } }));
      expect(analyticOf(r).groups[0]?.reason, verify).toBe('mismatch');
    }
  });
});

describe('analytic bake: verifier coverage (audit 7, mutation set)', () => {
  const surface = sphereZone(0.5, 0, 1.0);

  it('sample verifies 256 stratified points per group, all verifies every sub-sample', {
    timeout: 120000,
  }, () => {
    const s = scene(surface, { resolution: RES });
    const sample = analyticOf(bake(plain(s, { analytic: { verify: 'sample' } })));
    const all = analyticOf(bake(plain(s, { analytic: { verify: 'all' } })));
    expect(sample.groups[0]?.verified).toBe(256);
    expect(all.groups[0]?.verified).toBe(all.groups[0]?.analyticSamples);
    expect(all.groups[0]?.verified).toBeGreaterThan(1000);
  });

  it('a position-only bake checks the position tolerance by itself', { timeout: 120000 }, () => {
    const s = scene(surface, { resolution: RES });
    s.detail.editMesh.channels.delete('uv1');
    const only = { maps: ['position' as const] };
    const honest = bake(plain(s, { ...only, analytic: { verify: 'all' } }));
    const tolerance = analyticOf(honest).maps.find((m) => m.map === 'position')
      ?.tolerance as number;
    expect(analyticOf(honest).mismatches).toEqual([]);
    const wrong = patchOf(sphereZone(0.5 + 3 * tolerance, 0, 1.0));
    const caught = bake(plain(s, { ...only, analytic: { verify: 'all', patches: [wrong] } }));
    expect(analyticOf(caught).mismatches).toEqual([
      expect.objectContaining({ patch: 'p', map: 'position' }),
    ]);
  });
});

describe('analytic bake: a crease between patches (audit 8b, item 1)', () => {
  const hinge = (degrees: number) => {
    const a = (degrees * Math.PI) / 180;
    const flat = rectangle(0.15, 0.1, 0.1);
    return {
      ...flat,
      points: flat.points.map((row) =>
        row.map((q): [number, number, number] => [
          0.1 + (q[0] - 0.1) * Math.cos(a),
          q[1],
          (q[0] - 0.1) * Math.sin(a),
        ]),
      ),
    };
  };
  const tess = { chord: 0.01, angle: 12 };
  const pair = (second: AnalyticPatch['surface'], tag?: string) => {
    const both = (resolution?: number) => {
      const m = model();
      const report = m.surface({
        patches: [
          { surface: rectangle(0.05, 0.1, 0.1), name: 'a' },
          { surface: second, name: 'b' },
        ],
        ...tess,
        ...(tag === undefined ? {} : { tag }),
      });
      if (report.status !== 'ok') throw new Error(JSON.stringify(report).slice(0, 200));
      if (resolution !== undefined) m.uv.auto({ resolution, padding: 2 });
      return m;
    };
    const detail = both();
    const base = both(RES);
    return {
      detail,
      options: plain({ base, detail, surface: second }, { cage: { offset: 0.02, maxRay: 0.04 } }),
    };
  };

  it('a 30 degree crease keeps its honest patches analytic with a near-zero normal deviation (audit 9b)', {
    timeout: 120000,
  }, () => {
    const { options } = pair(hinge(30));
    const a = analyticOf(bake({ ...options, analytic: { verify: 'all' } }));
    expect(a.mismatches).toEqual([]);
    expect(a.groups[0]?.analytic).toBe(true);
    const normal = a.maps.find((m) => m.map === 'normal');
    expect(normal?.max).toBeLessThan(0.5);
  });

  const tiltedFlat = (degrees: number) => {
    const t = (degrees * Math.PI) / 180;
    const flat = rectangle(0.05, 0.1, 0.1);
    return {
      ...flat,
      points: flat.points.map((row) =>
        row.map((q): [number, number, number] => [
          0.05 + (q[0] - 0.05) * Math.cos(t),
          q[1],
          (q[0] - 0.05) * Math.sin(t),
        ]),
      ),
    };
  };

  it.each([
    2, 5, 8, 11,
  ])('a flat patch tilted %i degrees inside a 30 degree crease is refused on the normal channel by the verifier (audit 9b)', {
    timeout: 120000,
  }, (degrees) => {
    const { options } = pair(hinge(30));
    const wrong = analyticOf(
      bake({
        ...options,
        analytic: {
          verify: 'all',
          patches: [
            patchOf(tiltedFlat(degrees), { ...tess }, 'a'),
            patchOf(hinge(30), { ...tess }, 'b'),
          ],
        },
      }),
    );
    expect(wrong.groups[0]?.analytic).toBe(false);
    expect(wrong.groups[0]?.reason).toBe('mismatch');
    expect(wrong.mismatches.some((m) => m.patch === 'a' && m.map === 'normal')).toBe(true);
  });

  it.each([
    5, 8, 11,
  ])('without the domain channel a flat patch tilted %i degrees inside a 30 degree crease is refused at a 4 degree patch angle (audit 9b)', {
    timeout: 120000,
  }, (degrees) => {
    const { detail, options } = pair(hinge(30));
    detail.editMesh.channels.delete('uv1');
    const blind = analyticOf(
      bake({
        ...options,
        analytic: {
          verify: 'all',
          patches: [
            patchOf(tiltedFlat(degrees), { chord: 0.01, angle: 4 }, 'a'),
            patchOf(hinge(30), { chord: 0.01, angle: 4 }, 'b'),
          ],
        },
      }),
    );
    expect(blind.groups[0]?.analytic).toBe(false);
    expect(blind.mismatches.every((m) => m.patch === 'a')).toBe(true);
    expect(blind.mismatches.length).toBeGreaterThan(0);
  });

  it('without the domain channel the normal limit is the patch angle: a tilt of 8 degrees at the default angle 12 is accepted (documented loss, audit 9b item 3)', {
    timeout: 120000,
  }, () => {
    const { detail, options } = pair(hinge(30));
    detail.editMesh.channels.delete('uv1');
    const blind = analyticOf(
      bake({
        ...options,
        analytic: {
          verify: 'all',
          patches: [patchOf(tiltedFlat(8), { ...tess }, 'a'), patchOf(hinge(30), { ...tess }, 'b')],
        },
      }),
    );
    expect(blind.groups[0]?.analytic).toBe(true);
    const normal = blind.maps.find((m) => m.map === 'normal');
    expect(normal?.tolerance).toBeCloseTo(12 + normalStep(), 6);
  });

  it('a flat patch tilted 30 degrees inside a 30 degree crease is refused by the guard (audit 9b)', {
    timeout: 120000,
  }, () => {
    const { options } = pair(hinge(30));
    const wrong = analyticOf(
      bake({
        ...options,
        analytic: {
          verify: 'all',
          patches: [
            patchOf(tiltedFlat(30), { ...tess }, 'a'),
            patchOf(hinge(30), { ...tess }, 'b'),
          ],
        },
      }),
    );
    expect(wrong.groups[0]?.analytic).toBe(false);
    expect(wrong.groups[0]?.reason).toBe('detail-moved');
  });

  it('a mesh tag equal to a patch name does not make the guard compare every face against that patch (audit 8b, item 2)', {
    timeout: 120000,
  }, () => {
    const { detail, options } = pair(hinge(30), 'b');
    const right = bake({ ...options, analytic: { verify: 'all' } });
    expect(analyticOf(right).mismatches).toEqual([]);
    expect(analyticOf(right).groups[0]?.analytic).toBe(true);
    // Falsifier: the exact-tag patch moved is still refused (the guard keeps checking b's own faces).
    const moved = bake({
      ...options,
      analytic: {
        verify: 'all',
        patches: [
          patchOf(rectangle(0.05, 0.1, 0.1), { ...tess }, 'a'),
          patchOf(hinge(20), { ...tess }, 'b'),
        ],
      },
    });
    expect(analyticOf(moved).groups[0]?.reason).toBe('detail-moved');
    expect(detail.editMesh.faces().length).toBeGreaterThan(0);
  });
});

/** The uv1 domain of one corner: the test fixtures always write it, so an absent value is a broken fixture. */
function uv1Of(
  mesh: { corner(name: 'uv1', h: number): ArrayLike<number> | undefined },
  h: number,
): [number, number] {
  const v = mesh.corner('uv1', h);
  if (v === undefined) throw new Error(`corner ${h} has no uv1`);
  return [v[0] ?? NaN, v[1] ?? NaN];
}

describe('analytic bake: the guard and the limit as design points (audit 8b, item 5)', () => {
  const surface = sphereZone(0.5, 0, 1.0);
  const patch = patchOf(surface, { chord: 0.01, angle: 12 });
  const turnOf = (mesh: ReturnType<typeof patchModel>['editMesh']) => {
    const per: number[] = [];
    for (const f of mesh.faces()) {
      const normals = mesh.faceHalves(f).map((h) => {
        const st = uv1Of(mesh, h);
        return normalAt(patch, st[0], st[1]) as [number, number, number];
      });
      let worst = 0;
      for (let k = 0; k < normals.length; k++)
        worst = Math.max(
          worst,
          angleBetween(normals[k] as never, normals[(k + 1) % normals.length] as never),
        );
      per.push(worst);
    }
    return per;
  };

  it('the measured turn is the largest over all faces, wrap pair included', () => {
    for (const triangles of [false, true]) {
      const m = patchModel(surface, 'p', { chord: 0.01, angle: 12 });
      if (triangles) m.triangulate(sel.all());
      const per = turnOf(m.editMesh);
      const turn = guardPatches(m.editMesh, [patch], 'uv1')[0]?.turn as number;
      expect(turn).toBeCloseTo(Math.max(...per), 9);
      // The last face alone would under-report: the test needs a face that is not the worst.
      expect(per.at(-1) as number).toBeLessThan(turn);
    }
  });

  it('the normal limit is the turn plus one encoded step; no measurement falls back to the recorded angle', () => {
    const steps = { height: 1, position: 1, normal: normalStep() };
    expect(allowed(patch, steps, 3).normal).toBeCloseTo(3 + normalStep(), 12);
    expect(allowed(patch, steps, 0).normal).toBeCloseTo(normalStep(), 12);
    expect(allowed(patch, steps).normal).toBeCloseTo(12 + normalStep(), 12);
    expect(normalStep()).toBeCloseTo(0.4498, 3);
  });

  it('a corner domain slightly outside [0, 1] is clamped onto the edge before it is evaluated', () => {
    const m = patchModel(surface, 'p', { chord: 0.01, angle: 12 });
    const mesh = m.editMesh;
    let edited = 0;
    for (const f of mesh.faces())
      for (const h of mesh.faceHalves(f)) {
        const st = uv1Of(mesh, h);
        if (st[0] === 1 || st[1] === 0) {
          mesh.setCorner('uv1', h, [st[0] === 1 ? 1.2 : st[0], st[1] === 0 ? -0.2 : st[1]]);
          edited++;
        }
      }
    expect(edited).toBeGreaterThan(4);
    const guard = guardPatches(mesh, [patch], 'uv1')[0];
    expect(guard?.moved).toBe(0);
    expect(guard?.checked).toBeGreaterThan(edited);
    // The turn is measured on the clamped domain: clamping the stored values first changes nothing.
    for (const f of mesh.faces())
      for (const h of mesh.faceHalves(f)) {
        const st = uv1Of(mesh, h);
        mesh.setCorner('uv1', h, [
          Math.min(1, Math.max(0, st[0])),
          Math.min(1, Math.max(0, st[1])),
        ]);
      }
    expect(guardPatches(mesh, [patch], 'uv1')[0]?.turn).toBe(guard?.turn);
  });

  it('the wrap pair of a triangle counts: its largest turn can lie between the first and last corner', () => {
    const m = patchModel(surface, 'p', { chord: 0.01, angle: 12 });
    m.triangulate(sel.all());
    const mesh = m.editMesh;
    const before = guardPatches(mesh, [patch], 'uv1')[0]?.turn as number;
    const f = mesh.faces()[0] as number;
    const halves = mesh.faceHalves(f);
    expect(halves.length).toBe(3);
    // Three corners along one latitude, 0, 45 and 90 degrees of longitude: pairs 45, 45 and the wrap 90.
    for (const [k, s0] of [0, 0.5, 1].entries())
      mesh.setCorner('uv1', halves[k] as number, [s0, 0.5]);
    const turn = guardPatches(mesh, [patch], 'uv1')[0]?.turn as number;
    expect(turn).toBeGreaterThan(70);
    expect(turn).toBeGreaterThan(before + 40);
  });

  it('a floater tagged with a patch name on a moved detail reports detail-not-patches and no position mismatch', {
    timeout: 120000,
  }, () => {
    const s = scene(surface, { resolution: RES });
    s.detail.translate(sel.all(), [0.005, 0, 0]);
    const bolt = model();
    bolt.box({ size: [0.05, 0.05, 0.05], center: [0.3, 0.3, 0.9] });
    bolt.tag(sel.all(), 'p');
    bolt.tag(sel.all(), 'floater');
    fillUv1(bolt);
    s.detail.append(bolt);
    const a = analyticOf(
      bake(plain(s, { tags: { floater: 'floater' }, analytic: { verify: 'off' } })),
    );
    expect(a.groups[0]?.reason).toBe('detail-not-patches');
    expect(a.mismatches).toEqual([]);
  });

  it("the guard reads the detail's own domain channel, not the base's", { timeout: 120000 }, () => {
    const s = scene(surface, { resolution: RES });
    const rep = s.detail.uv.lightmap({ resolution: 64, domain: 'copyTo-uv2' });
    expect(rep.status).toBe('ok');
    expect(s.detail.analyticSource().domain).toBe('uv2');
    const a = analyticOf(bake(plain(s, { analytic: { verify: 'off' } })));
    expect(a.groups[0]?.reason).toBeUndefined();
    expect(a.groups[0]?.guarded).toBeGreaterThan(100);
    expect(a.mismatches).toEqual([]);
  });
});

describe('analytic bake: the stale-descriptor guard above its face stride (audit 9b, item 4)', () => {
  const fine = { chord: 0.0002, angle: 3 };
  const sphere = () => scene(sphereZone(0.5, 0, 1.0), { resolution: RES, detail: fine });
  const patchFine = () => patchOf(sphereZone(0.5, 0, 1.0), fine, 'p');
  const taggedFaces = (s: Scene) => {
    const m = s.detail.editMesh;
    const tag = m.tagIndex('p', false);
    return m.faces().filter((f) => m.hasTag(f, tag));
  };

  it('a patch above 2048 faces is guarded on a stride: at most 2048 faces, every other one for 2484 faces (audit 9b item 4)', {
    timeout: 120000,
  }, () => {
    const s = sphere();
    const faces = taggedFaces(s).length;
    expect(faces).toBeGreaterThan(2048);
    const a = analyticOf(bake(plain(s, { analytic: { verify: 'off', patches: [patchFine()] } })));
    const corners = a.groups[0]?.guarded ?? 0;
    // Four corners per quad face: without the stride every corner of every face would be compared.
    expect(corners).toBeLessThanOrEqual(4 * 2048);
    expect(corners).toBeLessThan(4 * faces);
    expect(corners).toBeGreaterThan(0);
    expect(a.groups[0]?.analytic).toBe(true);
  });

  it('a move confined to the tail of a patch above 2048 faces is caught by the stride, not by a first-2048 prefix (audit 9b item 4)', {
    timeout: 120000,
  }, () => {
    const s = sphere();
    const m = s.detail.editMesh;
    const set = taggedFaces(s);
    // Move only vertices no first-2048 face uses, so a prefix-only guard has no corner that sees the move.
    const prefix = new Set(set.slice(0, 2048).flatMap((f) => m.faceVertices(f)));
    const tail = new Set(
      set
        .slice(2100)
        .flatMap((f) => m.faceVertices(f))
        .filter((v) => !prefix.has(v)),
    );
    expect(tail.size).toBeGreaterThan(0);
    for (const v of tail) {
      const p = m.position(v);
      m.setPosition(v, p[0] + 0.01, p[1], p[2]);
    }
    // The guard reads this mesh in the order of tagged faces; the bake decodes a copy, so check the guard directly.
    const guard = guardPatches(m, [patchFine()], 'uv1')[0];
    expect(guard?.checked).toBeGreaterThan(0);
    expect(guard?.moved).toBeGreaterThan(0);
  });

  it('a patch that tags no detail face leaves the guard unchanged even when a previous face carries tag 31 (audit 9b, o12)', () => {
    const shape = sphereZone(0.5, 0, 1.0);
    const patch = patchOf(shape, { chord: 0.001, angle: 12 }, 'p');
    const absent = patchOf(shape, { chord: 0.001, angle: 12 }, 'absent');
    const detail = scene(shape, { resolution: RES, detail: { chord: 0.001, angle: 12 } }).detail
      .editMesh;
    for (let i = 0; i < 31; i++) detail.tagIndex(`x${i}`, true);
    const high = detail.tagIndex('x30', false);
    const faces = detail.faces();
    for (const f of faces) detail.addTag(f, high);
    const alone = guardPatches(detail, [patch], 'uv1')[0];
    const withAbsent = guardPatches(detail, [patch, absent], 'uv1')[0];
    expect(alone?.checked).toBeGreaterThan(0);
    expect(withAbsent).toEqual(alone);
  });

  it('a contiguous hole in a patch above the stride is caught by sample and all, and the guard-only mode misses it (audit 9b item 4)', {
    timeout: 120000,
  }, () => {
    for (const verify of ['sample', 'all'] as const) {
      const s = sphere();
      const tagged = taggedFaces(s);
      for (const f of tagged.slice(0, Math.round(tagged.length * 0.1)))
        s.detail.editMesh.removeFace(f);
      const a = analyticOf(bake(plain(s, { analytic: { verify, patches: [patchFine()] } })));
      expect(a.groups[0]?.analytic).toBe(false);
      expect(a.mismatches.length).toBeGreaterThan(0);
    }
    const off = sphere();
    const tagged = taggedFaces(off);
    for (const f of tagged.slice(0, Math.round(tagged.length * 0.1)))
      off.detail.editMesh.removeFace(f);
    expect(
      analyticOf(bake(plain(off, { analytic: { verify: 'off', patches: [patchFine()] } })))
        .groups[0]?.analytic,
    ).toBe(true);
  });

  it('a single deleted face of a 2484-face patch is caught by all but not by sample (256 stratified points); the loss is recorded (audit 9b item 4)', {
    timeout: 120000,
  }, () => {
    const hole = (verify: 'sample' | 'all') => {
      const s = sphere();
      s.detail.editMesh.removeFace(taggedFaces(s)[1] as number);
      return analyticOf(bake(plain(s, { analytic: { verify, patches: [patchFine()] } })));
    };
    expect(hole('all').groups[0]?.analytic).toBe(false);
    expect(hole('all').mismatches.length).toBeGreaterThan(0);
    expect(hole('sample').groups[0]?.analytic).toBe(true);
  });
});
