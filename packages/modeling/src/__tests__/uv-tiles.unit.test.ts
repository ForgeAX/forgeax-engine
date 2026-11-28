import { describe, expect, it } from 'vitest';
import { measureUv } from '../compute/uv-ts';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

type Metrics = Record<string, number>;

const infoOf = (report: OpReport) => {
  const info = report.diagnostics?.filter((d) => d.severity === 'info').at(-1);
  if (info === undefined) throw new Error(`${report.op}: ${report.error?.message}`);
  return info.detail as { metrics: Metrics; cacheKey: string };
};

const R = 256;
const PAD = 4;
const TAGS = ['a', 'b', 'c'] as const;

/** Three boxes of growing size, one tag each; sharp edges are seams so each box has several islands. */
function parts(scale = [1, 1.6, 2.4]): Model {
  const m = model();
  for (const [i, tag] of TAGS.entries()) {
    const k = scale[i] as number;
    m.box({ size: [k, k * 0.8, k * 0.6], center: [i * 4, 0, 0], label: `p${i}` });
    m.tag(sel.createdBy(`p${i}`), tag);
  }
  m.markSharp(sel.edges.dihedral('>', 30));
  m.uv.unwrap({ seams: 'sharp' });
  return m;
}

type PackOptions = Parameters<Model['uv']['pack']>[0];
const pack = (m: Model, extra: object = {}) =>
  m.uv.pack({ resolution: R, padding: PAD, method: 'raster', ...extra } as PackOptions);

/** Per face: its tag and the uv0 bounding box of its corners. */
function faceBoxes(m: Model) {
  const mesh = m.editMesh;
  const ids = TAGS.map((t) => mesh.tagIndex(t, false));
  return mesh.faces().map((f) => {
    const box = { u0: 1e9, v0: 1e9, u1: -1e9, v1: -1e9 };
    for (const h of mesh.faceHalves(f)) {
      const c = mesh.corner('uv0', h) as Float32Array;
      box.u0 = Math.min(box.u0, c[0] as number);
      box.v0 = Math.min(box.v0, c[1] as number);
      box.u1 = Math.max(box.u1, c[0] as number);
      box.v1 = Math.max(box.v1, c[1] as number);
    }
    return { ...box, tag: TAGS[ids.findIndex((id) => id >= 0 && mesh.hasTag(f, id))] as string };
  });
}

/** Texels per meter of the faces carrying `tag`. */
function density(m: Model, tag: string): number {
  const mesh = m.editMesh;
  const measured = measureUv(mesh);
  if (!measured.ok) throw measured.error;
  const id = mesh.tagIndex(tag, false);
  const mine = new Set<number>();
  for (const f of mesh.faces()) {
    if (mesh.hasTag(f, id)) mine.add(measured.value.faceIsland[f] as number);
  }
  let a3 = 0;
  let au = 0;
  for (const i of mine) {
    const x = measured.value.islands[i] as { areaUv: number; area3d: number };
    a3 += x.area3d;
    au += x.areaUv;
  }
  return R * Math.sqrt(au / a3);
}

const cellOf = (b: { u0: number; v0: number; u1: number; v1: number }) => [
  Math.floor(b.u0 + 1e-9),
  Math.floor(b.v0 + 1e-9),
];

describe('uv.pack tiles', () => {
  it('by group: every island of a part lies inside the tile of its part, padding included (falsifier: one atlas)', () => {
    const m = parts();
    const report = pack(m, { groups: [...TAGS], tiles: { across: 2, by: 'group' } });
    expect(report.status).toBe('ok');
    const edge = PAD / 2 / R - 1e-6;
    const seen = new Set<string>();
    for (const b of faceBoxes(m)) {
      const t = TAGS.indexOf(b.tag as (typeof TAGS)[number]);
      const cell = [t % 2, Math.floor(t / 2)];
      expect(cellOf(b)).toEqual(cell);
      expect(b.u0).toBeGreaterThanOrEqual((cell[0] as number) + edge);
      expect(b.v0).toBeGreaterThanOrEqual((cell[1] as number) + edge);
      expect(b.u1).toBeLessThanOrEqual((cell[0] as number) + 1 - edge);
      expect(b.v1).toBeLessThanOrEqual((cell[1] as number) + 1 - edge);
      seen.add(cell.join(','));
    }
    expect(seen.size).toBe(3);
    const metrics = infoOf(report).metrics;
    expect(metrics.tiles).toBe(3);
    expect(metrics.tileUtilizationMin).toBeLessThanOrEqual(metrics.tileUtilizationMax as number);
    expect(m.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain('uv-overlap');
  });

  it('without tiles every island shares the unit square (the same scene, the mutant the tile test rejects)', () => {
    const m = parts();
    expect(pack(m, { groups: [...TAGS] }).status).toBe('ok');
    for (const b of faceBoxes(m)) expect(cellOf(b)).toEqual([0, 0]);
  });

  it('by zone: tags land in their declared cell and validate surface passes', () => {
    const m = parts();
    const zones = { a: [1, 0], b: [0, 0], c: [2, 0] } as const;
    const report = pack(m, { groups: [...TAGS], tiles: { across: 3, by: 'zone', zones } });
    expect(report.status).toBe('ok');
    for (const b of faceBoxes(m)) expect(cellOf(b)).toEqual(zones[b.tag as keyof typeof zones]);
    const surface = m
      .validate({ surface: { zones, need: ['uv0'] } })
      .issues.filter((i) => i.code === 'surface');
    expect(surface).toEqual([]);
  });

  it('by zone: a part without a cell, or a cell outside the grid, is refused', () => {
    const missing = pack(parts(), {
      groups: [...TAGS],
      tiles: { across: 3, by: 'zone', zones: { a: [0, 0], b: [1, 0] } },
    });
    expect(missing.status).toBe('failed');
    expect(missing.error?.code).toBe('model-precondition');
    expect(missing.error?.detail).toMatchObject({ reason: 'tile-zone-unknown', tag: 'c' });
    const outside = pack(parts(), {
      groups: [...TAGS],
      tiles: { across: 2, down: 1, by: 'zone', zones: { a: [0, 0], b: [1, 0], c: [0, 1] } },
    });
    expect(outside.error?.code).toBe('model-invalid-argument');
  });

  it('stacked islands of two parts in different tiles are refused', () => {
    const twins = () => {
      const m = model();
      for (const [i, tag] of (['a', 'b'] as const).entries()) {
        m.box({ size: [1, 0.8, 0.6], center: [i * 4, 0, 0], label: `p${i}` });
        m.tag(sel.createdBy(`p${i}`), tag);
      }
      m.markSharp(sel.edges.dihedral('>', 30));
      m.uv.unwrap({ seams: 'sharp' });
      return m;
    };
    const apart = pack(twins(), {
      groups: ['a', 'b'],
      stack: true,
      tiles: { across: 2, by: 'zone', zones: { a: [0, 0], b: [1, 0] } },
    });
    expect(apart.status).toBe('failed');
    expect(apart.error?.detail).toMatchObject({ reason: 'tile-stack-conflict' });
    const together = pack(twins(), {
      groups: ['a', 'b'],
      stack: true,
      tiles: { across: 2, by: 'zone', zones: { a: [1, 0], b: [1, 0] } },
    });
    expect(together.status).toBe('ok');
  });

  it('a part too large for its tile fails with the tile and the density that fits', () => {
    const m = parts();
    const report = pack(m, {
      groups: [...TAGS],
      tiles: { across: 2, by: 'group' },
      density: { target: 300 },
    });
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('model-precondition');
    const detail = report.error?.detail as { achievable: number; tile?: number };
    expect(detail.achievable).toBeGreaterThan(0);
    expect(detail.achievable).toBeLessThan(300);
    expect(detail.tile).toBeGreaterThanOrEqual(0);
    const retry = parts();
    expect(
      pack(retry, {
        groups: [...TAGS],
        tiles: { across: 2, by: 'group' },
        density: { target: detail.achievable * 0.98 },
      }).status,
    ).toBe('ok');
  });

  it('by fit: at a density one tile cannot hold the overflow spills on, first tile fullest', () => {
    const m = parts();
    const report = pack(m, { tiles: { across: 3, by: 'fit' }, density: { target: 50 } });
    expect(report.status).toBe('ok');
    const cells = new Set(faceBoxes(m).map((b) => cellOf(b).join(',')));
    expect(cells.size).toBeGreaterThan(1);
    const { metrics } = infoOf(report);
    expect(metrics.tiles).toBe(cells.size);
    expect(metrics.tileUtilizationMax).toBeGreaterThan(metrics.tileUtilizationMin as number);
    const small = parts();
    expect(pack(small, { tiles: { across: 3, by: 'fit' }, density: { target: 20 } }).status).toBe(
      'ok',
    );
    expect(new Set(faceBoxes(small).map((b) => cellOf(b).join(','))).size).toBe(1);
  });

  it('by fit: too few tiles fails instead of dropping islands', () => {
    const report = pack(parts(), { tiles: { across: 1, by: 'fit' }, density: { target: 50 } });
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('model-precondition');
  });

  it('invalid tile options are model-invalid-argument', () => {
    for (const tiles of [
      { across: 0, by: 'fit' },
      { across: 2, by: 'group' },
      { across: 2, by: 'zone' },
      { across: 2, by: 'fit', zones: { a: [0, 0] } },
      { across: 9, down: 9, by: 'fit' },
    ]) {
      expect(pack(parts(), { tiles }).error?.code).toBe('model-invalid-argument');
    }
    const skyline = parts().uv.pack({
      resolution: R,
      padding: PAD,
      tiles: { across: 2, by: 'fit' },
    });
    expect(skyline.error?.code).toBe('model-invalid-argument');
  });

  it('tiles are part of the job identity', () => {
    const key = (tiles?: object) => infoOf(pack(parts(), { groups: [...TAGS], tiles })).cacheKey;
    expect(key({ across: 3, by: 'group' })).not.toBe(key({ across: 2, by: 'group' }));
    expect(key({ across: 3, by: 'group' })).not.toBe(key(undefined));
  });
});

describe('uv.pack priority', () => {
  const bytes = (m: Model) =>
    JSON.stringify(
      m.editMesh
        .faces()
        .map((f) =>
          m.editMesh.faceHalves(f).map((h) => Array.from(m.editMesh.corner('uv0', h) ?? [])),
        ),
    );

  it('absent or empty is byte-identical to no priority', () => {
    const none = parts();
    pack(none, { groups: [...TAGS] });
    const empty = parts();
    pack(empty, { groups: [...TAGS], priority: {} });
    expect(bytes(empty)).toBe(bytes(none));
  });

  it('with a density the target cannot hold for all, the priority part keeps the target (falsifier: no priority drops it)', () => {
    const base = parts();
    expect(pack(base, { groups: [...TAGS] }).status).toBe('ok');
    const fit = density(base, 'a');
    const options = { groups: [...TAGS], density: { target: fit * 1.3, tolerance: 0.45 } };
    const flat = parts();
    expect(pack(flat, options).status).toBe('ok');
    expect(density(flat, 'a')).toBeLessThan(fit * 1.3 * 0.999);
    const ranked = parts();
    const report = pack(ranked, { ...options, priority: { a: 1 } });
    expect(report.status).toBe('ok');
    expect(density(ranked, 'a')).toBeCloseTo(fit * 1.3, 2);
    expect(density(ranked, 'b')).toBeLessThan(fit * 1.3);
    expect(density(ranked, 'b')).toBeGreaterThanOrEqual(fit * 1.3 * 0.55 - 1e-6);
    expect(ranked.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain(
      'uv-overlap',
    );
  });

  it('priority places its group first, so a small prioritized part leads the layout (grouped and ungrouped)', () => {
    const lead = (m: Model) => {
      const a = faceBoxes(m).filter((b) => b.tag === 'a');
      return [Math.min(...a.map((b) => b.u0)), Math.min(...a.map((b) => b.v0))];
    };
    const origin = PAD / R / 2 + 1 / R;
    for (const groups of [true, false]) {
      const base = parts();
      pack(base, groups ? { groups: [...TAGS] } : {});
      const ranked = parts();
      pack(ranked, { ...(groups ? { groups: [...TAGS] } : {}), priority: { a: 1 } });
      expect(lead(ranked)).not.toEqual(lead(base));
      if (groups) {
        expect(lead(ranked)[0]).toBeCloseTo(origin, 2);
        expect(lead(ranked)[1]).toBeCloseTo(origin, 2);
      }
    }
  });

  it('priority orders by fit: the high priority part takes tile 0', () => {
    const m = parts();
    const report = pack(m, {
      groups: [...TAGS],
      tiles: { across: 3, by: 'fit' },
      density: { target: 50 },
      priority: { a: 2 },
    });
    expect(report.status).toBe('ok');
    const a = faceBoxes(m).filter((b) => b.tag === 'a');
    for (const b of a) expect(cellOf(b)).toEqual([0, 0]);
  });

  it('invalid priority is refused', () => {
    expect(pack(parts(), { priority: { a: Number.NaN } }).error?.code).toBe(
      'model-invalid-argument',
    );
    expect(parts().uv.pack({ resolution: R, padding: PAD, priority: { a: 1 } }).error?.code).toBe(
      'model-invalid-argument',
    );
  });
});

describe('uv.pack fill', () => {
  it("'tight' never packs fewer texels than the proportional layout and is deterministic", () => {
    const flat = parts();
    const tight = parts();
    const again = parts();
    const a = infoOf(pack(flat, { groups: [...TAGS] }));
    const b = infoOf(pack(tight, { groups: [...TAGS], fill: 'tight' }));
    const c = infoOf(pack(again, { groups: [...TAGS], fill: 'tight' }));
    expect(b.metrics.texelsPerMeter).toBeGreaterThanOrEqual(
      (a.metrics.texelsPerMeter as number) * 0.999,
    );
    expect(c.metrics.texelsPerMeter).toBe(b.metrics.texelsPerMeter);
  });

  it('a budget the tight search cannot afford falls back to the proportional layout (not a failure)', () => {
    const flat = parts();
    const a = pack(flat, { groups: [...TAGS] });
    const cost = infoOf(a).metrics.work as number;
    const m = model({ budget: { work: Math.ceil(cost * 1.5) } });
    for (const [i, tag] of TAGS.entries()) {
      const k = [1, 1.6, 2.4][i] as number;
      m.box({ size: [k, k * 0.8, k * 0.6], center: [i * 4, 0, 0], label: `p${i}` });
      m.tag(sel.createdBy(`p${i}`), tag);
    }
    m.markSharp(sel.edges.dihedral('>', 30));
    m.uv.unwrap({ seams: 'sharp' });
    const tight = pack(m, { groups: [...TAGS], fill: 'tight' });
    expect(tight.status).toBe('ok');
    expect(infoOf(tight).metrics.texelsPerMeter).toBe(infoOf(a).metrics.texelsPerMeter);
  });

  it('fill needs groups', () => {
    expect(pack(parts(), { fill: 'tight' }).error?.code).toBe('model-invalid-argument');
    expect(pack(parts(), { groups: [...TAGS], fill: 'loose' }).error?.code).toBe(
      'model-invalid-argument',
    );
  });
});
