import { describe, expect, it } from 'vitest';
import { type BakeExecutor, type BakeOptions, bakeMaps, bakeMapsParallel } from '../bake';
import { bakePhases } from '../compute/bake-ts';
import { WorkMeter } from '../compute/job';
import { type Model, model } from '../model';
import { sel } from '../selectors';

/**
 * Cage-clip and stray-detail checks: a cage that clips a small feature, a hole deeper than the cage and a
 * hovering foreign part all passed before (V2 reports only below 99 % ray hits; misses
 * fall back to the nearest point). Each now fails with a located issue; a cage that
 * covers the feature, and a tagged floater, still pass.
 */

const step = (e0: number, e1: number, x: number) => Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
const FEATURES = {
  /** 45 degree frustum emboss, top half-width 0.03 m, 0.03 m high. */
  smallstamp: (x: number, y: number) =>
    Math.max(0, Math.min(0.03, 0.06 - Math.max(Math.abs(x), Math.abs(y)))),
  /** Blind hole r 0.05 m, 0.1 m deep. */
  smallhole: (x: number, y: number) => -0.1 * step(0.054, 0.05, Math.hypot(x, y)),
  flat: () => 0,
};

/** A 1 m heightfield z = f(x, y) on an n x n grid (two triangles per cell), plus optional extra quads. */
function heightfield(
  f: (x: number, y: number) => number,
  n: number,
  extra: number[][][] = [],
): Model {
  const m = model();
  const mesh = m.editMesh;
  const ids: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -0.5 + i / n;
      const y = -0.5 + j / n;
      ids.push(mesh.addVertex(x, y, f(x, y)));
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = ids[j * (n + 1) + i] as number;
      const b = ids[j * (n + 1) + i + 1] as number;
      const c = ids[(j + 1) * (n + 1) + i + 1] as number;
      const d = ids[(j + 1) * (n + 1) + i] as number;
      mesh.addFace([a, b, c]);
      mesh.addFace([a, c, d]);
    }
  }
  for (const quad of extra) {
    mesh.addFace(quad.map((p) => mesh.addVertex(p[0] as number, p[1] as number, p[2] as number)));
  }
  return m;
}

/** The flat 1 m plate z = 0 with uv0 over [0, 1]. */
function plate(): Model {
  const m = model();
  const mesh = m.editMesh;
  const f = mesh.addFace([
    mesh.addVertex(-0.5, -0.5, 0),
    mesh.addVertex(0.5, -0.5, 0),
    mesh.addVertex(0.5, 0.5, 0),
    mesh.addVertex(-0.5, 0.5, 0),
  ]);
  if (!f.ok) throw f.error;
  for (const h of mesh.faceHalves(f.value)) {
    const [x, y] = mesh.position(mesh.hVert[h] as number) as [number, number, number];
    mesh.setCorner('uv0', h, [x + 0.5, y + 0.5]);
  }
  return m;
}

function bake(detail: Model, extra: Partial<BakeOptions> = {}) {
  const r = bakeMaps({
    base: plate(),
    detail,
    maps: ['normal', 'height'],
    resolution: 64,
    filter: 'none',
    detailNormals: { mode: 'flat' },
    ...extra,
  });
  if (!r.ok) throw r.error;
  return r.value;
}

const codes = (r: ReturnType<typeof bake>) => r.issues.map((i) => i.code);

describe('cage-clip: facing detail outside the cage span (audit A1)', () => {
  it('a cage starting under a 3 cm stamp top fails; one above it passes (falsifier)', {
    timeout: 30000,
  }, () => {
    const detail = heightfield(FEATURES.smallstamp, 128);
    const clipped = bake(detail, { cage: { offset: 0.01, maxRay: 0.1 } });
    expect(clipped.pass).toBe(false);
    const issue = clipped.issues.find((i) => i.code === 'cage-clip');
    expect(issue?.detail).toMatchObject({ subject: '', offset: 0.01, maxRay: 0.1 });
    // The stamp top (0.06 m square of a 1 m plate) is under 1 % of the samples: V2 stays quiet.
    expect(codes(clipped)).not.toContain('ray-miss');
    expect(clipped.provenance.groups[0]?.clipped).toBeGreaterThan(0);
    const covered = bake(detail, { cage: { offset: 0.05, maxRay: 0.1 } });
    expect(covered.provenance.groups[0]?.clipped).toBe(0);
    expect(codes(covered)).not.toContain('cage-clip');
  });

  it('a hole deeper than maxRay fails; a cage reaching its floor passes (falsifier)', {
    timeout: 30000,
  }, () => {
    const detail = heightfield(FEATURES.smallhole, 128);
    const shallow = bake(detail, { cage: { offset: 0.05, maxRay: 0.1 } });
    expect(codes(shallow)).toContain('cage-clip');
    const deep = bake(detail, { cage: { offset: 0.05, maxRay: 0.2 } });
    expect(codes(deep)).not.toContain('cage-clip');
  });
});

describe('stray-detail: a part hovering off the base (audit A3)', () => {
  /** A 0.2 m square tilted 30 degrees, centered 0.1 m above the plate. */
  const hovering = (half: number): number[][][] => {
    const a = Math.PI / 6;
    return [
      [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
      ].map(([x, y]) => [
        x as number,
        (y as number) * Math.cos(a),
        0.1 + (y as number) * Math.sin(a),
      ]),
    ];
  };

  it('the automatic cage captures it and the bake fails; tagged as a floater it passes', {
    timeout: 30000,
  }, () => {
    const stray = bake(heightfield(FEATURES.flat, 64, hovering(0.1)));
    const issue = stray.issues.find((i) => i.code === 'stray-detail');
    expect(stray.pass).toBe(false);
    expect(issue?.detail).toMatchObject({ subject: '', parts: 1 });
    expect(issue?.detail.gap).toBeCloseTo(0.05, 3);
    expect(issue?.detail.samples as number).toBeGreaterThan(0);
    const tagged = heightfield(FEATURES.flat, 64, hovering(0.1));
    const mesh = tagged.editMesh;
    const last = [...mesh.faces()].at(-1) as number;
    mesh.addTag(last, mesh.tagIndex('float', true));
    const floater = bake(tagged, { tags: { floater: 'float' } });
    expect(codes(floater)).not.toContain('stray-detail');
    // A bump attached to the plate is relief, not a stray part (falsifier).
    expect(codes(bake(heightfield(FEATURES.smallstamp, 64)))).toEqual([]);
  });
});

describe('stack-conflict on height and a severe floor (audit A6)', () => {
  const P = 0.1;
  /** Two plates at x = -P and x = +P stacked on one UV square. */
  function plates(): Model {
    const m = model();
    for (const cx of [-P, P]) {
      const one = model();
      one.plane({ width: P, height: P, widthSegments: 4, heightSegments: 4 });
      one.translate(sel.all(), [cx, 0, 0]);
      m.append(one);
    }
    const mesh = m.editMesh;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const [x, y] = mesh.position(mesh.hVert[h] as number) as [number, number, number];
        mesh.setCorner('uv0', h, [(x - (x > 0 ? P : -P)) / P + 0.5, y / P + 0.5]);
      }
    }
    return m;
  }
  const flat = (cx: number, z: number) => {
    const m = model();
    m.plane({ width: 1.2 * P, height: 1.2 * P, widthSegments: 2, heightSegments: 2 });
    m.translate(sel.all(), [cx, 0, z]);
    return m;
  };
  const stacked = (detail: Model, maps: BakeOptions['maps']) => {
    const r = bakeMaps({
      base: plates(),
      detail,
      maps,
      resolution: 64,
      cage: { offset: 0.03, maxRay: 0.06 },
    });
    if (!r.ok) throw r.error;
    return r.value;
  };

  it('a 4 mm bump on one stacked plate fails below the 1 % ratio; identical plates pass (falsifier)', {
    timeout: 30000,
  }, () => {
    const bumped = model();
    bumped.append(flat(-P, 0));
    bumped.append(flat(P, 0));
    const bump = model();
    bump.sphere({
      radius: 0.004,
      widthSegments: 24,
      heightSegments: 12,
      center: [P + 0.02, 0.01, 0],
    });
    bumped.append(bump);
    const r = stacked(bumped, ['normal']);
    expect(r.provenance.stack.conflicts).toBeLessThan(0.01 * r.provenance.stack.samples);
    expect(r.issues.find((i) => i.code === 'stack-conflict')?.detail.maxAngle).toBeGreaterThan(45);
    const same = model();
    same.append(flat(-P, 0));
    same.append(flat(P, 0));
    expect(codes(stacked(same, ['normal']))).not.toContain('stack-conflict');
  });

  it('plates 9 mm apart in height conflict without a normal map', { timeout: 30000 }, () => {
    const apart = model();
    apart.append(flat(-P, 0.005));
    apart.append(flat(P, -0.004));
    const r = stacked(apart, ['height']);
    expect(r.provenance.stack.samples).toBeGreaterThan(0);
    expect(r.provenance.stack.maxHeight).toBeCloseTo(0.009, 4);
    expect(codes(r)).toContain('stack-conflict');
  });
});

describe('tangent-seam: a mixed-handedness base triangle (audit A4 check)', () => {
  /** A half plate (uv.auto), mirrored across x = 0 and welded at the seam. */
  function mirrored(): Model {
    const m = model();
    m.plane({ width: 0.5, height: 1, widthSegments: 8, heightSegments: 16 });
    m.translate(sel.all(), [-0.25, 0, 0]);
    m.uv.auto({ resolution: 128, padding: 4 });
    m.mirror({ axis: 'x', weldDistance: 1e-6 });
    return m;
  }
  const detail = model();
  detail.plane({ width: 1.2, height: 1.2 });
  const options = (): BakeOptions => ({
    base: mirrored(),
    detail,
    maps: ['normal'],
    resolution: 64,
    cage: { offset: 0.01, maxRay: 0.02 },
  });

  it('exportMesh splits the welded seam, so no triangle mixes handedness (#339)', {
    timeout: 30000,
  }, () => {
    const r = bakeMaps(options());
    if (!r.ok) throw r.error;
    expect(r.value.provenance.handedness.samples).toBe(0);
    expect(codes(r.value)).not.toContain('tangent-seam');
  });

  it('a base corner of flipped handedness fires (falsifier)', { timeout: 30000 }, async () => {
    // exportMesh no longer emits such a triangle from a Model, so flip one corner's w in the
    // prepared surface: the check must see it through the ordinary row phase.
    const flipped: BakeExecutor = async (request, rows, { budget }) => {
      const prepared = bakePhases.prepare(request, new WorkMeter(Number.POSITIVE_INFINITY));
      if (!prepared.ok) throw prepared.error;
      const b = prepared.value.atlas?.surface;
      if (b === undefined) throw new Error('no atlas');
      const corner = b.indices[0] as number;
      b.tangent[corner * 4 + 3] = -(b.tangent[corner * 4 + 3] as number);
      const parts = rows.map((row) => {
        const part = bakePhases.rows(prepared.value, [row], new WorkMeter(budget));
        if (!part.ok) throw part.error;
        return part.value;
      });
      return { ok: true, parts, work: 0 };
    };
    const r = await bakeMapsParallel(options(), flipped);
    if (!r.ok) throw r.error;
    expect(r.value.provenance.handedness.samples).toBeGreaterThan(0);
    expect(r.value.issues.find((i) => i.code === 'tangent-seam')?.severity).toBe('warn');
  });
});

describe('cage estimate, options, filter and work (audit A2, A9, A13, A12)', () => {
  it('A2: the automatic cage of a 0.1 m blind hole measures its floor, not its walls', {
    timeout: 30000,
  }, () => {
    const r = bake(heightfield(FEATURES.smallhole, 128));
    const g = r.provenance.groups[0];
    expect((g?.maxRay as number) - (g?.offset as number)).toBeLessThan(0.12);
    expect(g?.offset as number).toBeLessThan(0.01);
  });

  it('A9: an unknown or removed option is model-invalid-argument naming it', () => {
    const detail = heightfield(FEATURES.flat, 8);
    const top = bakeMaps({
      base: plate(),
      detail,
      maps: ['normal'],
      resolution: 16,
      distance: 0.1,
    } as never);
    expect(top.ok).toBe(false);
    if (!top.ok) expect(top.error.detail).toMatchObject({ option: 'distance' });
    const nested = bakeMaps({
      base: plate(),
      detail,
      maps: ['ao'],
      resolution: 16,
      ao: { reach: 0.1 },
    } as never);
    if (nested.ok) throw new Error('nested typo accepted');
    expect(nested.error.code).toBe('model-invalid-argument');
    expect(nested.error.detail?.option).toBe('ao.reach');
  });

  it('A13: the B-spline filter keeps a 45 degree chamfer crease (falsifier: no crease test blurs it)', {
    timeout: 30000,
  }, () => {
    const chamfer = (x: number) => Math.max(0, Math.min(0.1, 0.25625 - Math.abs(x)));
    const detail = heightfield((x) => chamfer(x), 64);
    const r = bake(detail, {
      maps: ['normalObject'],
      filter: 'bspline',
      cage: { offset: 0.12, maxRay: 0.24 },
    });
    const data = r.textures.normalObject?.data as Uint8Array;
    // The top |x| < 10/64 m ends on a texel edge; its texels next to the crease stay +z.
    let worst = 0;
    for (let j = 8; j < 56; j++) {
      for (const i of [22, 41]) {
        const o = (j * 64 + i) * 4;
        worst = Math.max(worst, Math.abs((data[o] as number) - 128));
      }
    }
    expect(worst).toBeLessThanOrEqual(2);
  });
});
