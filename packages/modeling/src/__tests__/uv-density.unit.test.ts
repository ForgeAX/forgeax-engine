import { describe, expect, it } from 'vitest';
import { partList } from '../compute/uv-parts';
import { measureUv } from '../compute/uv-ts';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

type Metrics = Record<string, number>;

function infoOf(report: OpReport) {
  const info = report.diagnostics?.filter((d) => d.severity === 'info').at(-1);
  if (info === undefined) throw new Error(`${report.op}: ${report.error?.message}`);
  return info.detail as {
    metrics: Metrics;
    cacheKey: string;
    parts?: { part: string | null; ratio: number }[];
  };
}

const warnings = (report: OpReport) =>
  (report.diagnostics ?? []).filter((d) => d.severity === 'warn').map((d) => d.message);

/** Six boxes of different sizes: two tagged hero, two hidden, two plain; one island per face. */
function parts(): Model {
  const m = model();
  const kind = ['hero', 'hidden', undefined, 'hero', 'hidden', undefined] as const;
  for (const [i, tag] of kind.entries()) {
    m.box({
      size: [1 + 0.3 * (i % 3), 0.6 + 0.1 * i, 0.8],
      center: [i * 2.5, 0, 0],
      label: `b${i}`,
    });
    if (tag !== undefined) m.tag(sel.createdBy(`b${i}`), tag);
  }
  m.markSharp(sel.edges.dihedral('>', 30));
  m.uv.unwrap({ seams: 'sharp' });
  return m;
}

/** Texels per meter of the islands whose faces carry `tag` (the islands with no tag at all when undefined). */
function densities(m: Model, resolution: number, tag?: string): number[] {
  const mesh = m.editMesh;
  const measured = measureUv(mesh);
  if (!measured.ok) throw measured.error;
  const id = tag === undefined ? -1 : mesh.tagIndex(tag, false);
  const tagged = new Set<number>();
  const mine = new Set<number>();
  const all = new Set<number>();
  for (const f of mesh.faces()) {
    const island = measured.value.faceIsland[f] as number;
    all.add(island);
    if (id >= 0 && mesh.hasTag(f, id)) mine.add(island);
    for (const name of ['hero', 'hidden']) {
      const t = mesh.tagIndex(name, false);
      if (t >= 0 && mesh.hasTag(f, t)) tagged.add(island);
    }
  }
  const wanted = tag === undefined ? [...all].filter((i) => !tagged.has(i)) : [...mine];
  return wanted.map((i) => {
    const x = measured.value.islands[i] as { areaUv: number; area3d: number };
    return resolution * Math.sqrt(x.areaUv / x.area3d);
  });
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const bytes = (m: Model) =>
  JSON.stringify(
    m.editMesh
      .faces()
      .map((f) =>
        m.editMesh.faceHalves(f).map((h) => Array.from(m.editMesh.corner('uv0', h) ?? [])),
      ),
  );

describe('uv.pack density parts (BK53)', () => {
  const R = 512;
  const pack = (m: Model, density: object, extra: object = {}) =>
    m.uv.pack({ resolution: R, padding: 4, ...extra, density } as Parameters<
      Model['uv']['pack']
    >[0]);

  it('packs each part at its multiplier of the base density (falsifier: no parts gives one density)', () => {
    const flat = parts();
    expect(pack(flat, {}).status).toBe('ok');
    const base = mean(densities(flat, R, 'hero'));
    expect(mean(densities(flat, R, 'hidden'))).toBeCloseTo(base, 3);

    const m = parts();
    const report = pack(m, { parts: { hero: 2, hidden: 0.5 } });
    expect(report.status).toBe('ok');
    const hero = densities(m, R, 'hero');
    const hidden = densities(m, R, 'hidden');
    const plain = densities(m, R);
    expect(hero).toHaveLength(12);
    const unit = mean(plain);
    for (const d of hero) expect(d / unit).toBeCloseTo(2, 3);
    for (const d of hidden) expect(d / unit).toBeCloseTo(0.5, 3);
    for (const d of plain) expect(d / unit).toBeCloseTo(1, 3);
    expect(m.validate({ uniqueUv: true }).issues.map((i) => i.code)).not.toContain('uv-overlap');
    const table = infoOf(report).parts ?? [];
    expect(table.map((r) => r.part)).toEqual(['hero', 'hidden', null]);
    expect(table.map((r) => Math.round(r.ratio * 1000) / 1000)).toEqual([2, 0.5, 1]);
  });

  it('a target is the base density; the hero part gets twice the texels per meter', () => {
    const m = parts();
    expect(pack(m, { target: 30, parts: { hero: 2 } }).status).toBe('ok');
    for (const d of densities(m, R, 'hero')) expect(d).toBeCloseTo(60, 3);
    for (const d of densities(m, R, 'hidden')) expect(d).toBeCloseTo(30, 3);
  });

  it('equal multipliers and the listed order change nothing; all-ones equals no parts (byte identical)', () => {
    const none = parts();
    pack(none, {});
    const ones = parts();
    pack(ones, { parts: { hero: 1, hidden: 1 } });
    expect(bytes(ones)).toBe(bytes(none));
    const ab = parts();
    pack(ab, { parts: { hero: 2, hidden: 0.5 } });
    const ba = parts();
    pack(ba, { parts: { hidden: 0.5, hero: 2 } });
    expect(bytes(ba)).toBe(bytes(ab));
  });

  it('the job identity does not depend on the key order of the table (falsifier: unsorted pairs)', () => {
    const key = (table: Record<string, number>) => {
      const m = parts();
      const report = pack(m, { parts: table });
      return infoOf(report).cacheKey;
    };
    expect(key({ hero: 2, hidden: 0.5 })).toBe(key({ hidden: 0.5, hero: 2 }));
    expect(key({ hero: 2, hidden: 0.5 })).not.toBe(key({ hero: 2, hidden: 0.25 }));
    expect(partList({ b: 1, a: 2 })).toEqual(partList({ a: 2, b: 1 }));
  });

  it('an empty table is no table: same identity and bytes, no part rows', () => {
    const none = parts();
    const plain = pack(none, {});
    const empty = parts();
    const report = pack(empty, { parts: {} });
    expect(report.status).toBe('ok');
    expect(bytes(empty)).toBe(bytes(none));
    expect(infoOf(report).cacheKey).toBe(infoOf(plain).cacheKey);
    expect(infoOf(report).parts).toBeUndefined();
  });

  it('bounds the multiplier span at 64x with the base 1 (falsifier: 1e-9 collapsed islands to zero area)', () => {
    for (const bad of [
      { hero: 1e-9 },
      { hero: 1e9 },
      { hero: 65 },
      { hero: 1 / 65 },
      { hero: 100, hidden: 2 },
      { hero: 9, hidden: 0.125 },
    ]) {
      const m = parts();
      const before = bytes(m);
      pack(m, { parts: bad });
      expect(m.poisoned?.code).toBe('model-invalid-argument');
      expect(bytes(m)).toBe(before);
    }
    const edge = parts();
    expect(pack(edge, { parts: { hero: 8, hidden: 0.125 } }).status).toBe('ok');
    const half = parts();
    expect(pack(half, { parts: { hero: 4, hidden: 0.25 } }).status).toBe('ok');
  });

  it('refuses bad multipliers and parts without normalize', () => {
    for (const bad of [{ hero: 0 }, { hero: -1 }, { hero: Number.NaN }, { '': 2 }]) {
      const m = parts();
      pack(m, { parts: bad });
      expect(m.poisoned?.code).toBe('model-invalid-argument');
    }
    const m = parts();
    pack(m, { parts: { hero: 2 } }, { normalize: false });
    expect(m.poisoned?.code).toBe('model-invalid-argument');
  });

  it('warns about a part no face carries and about islands spanning two parts', () => {
    const m = parts();
    const report = pack(m, { parts: { hero: 2, ghost: 3 } });
    expect(report.status).toBe('ok');
    expect(warnings(report).some((w) => /ghost/.test(w))).toBe(true);
    // A planar projection joins the faces of a box into one island: two tags share it.
    const mixed = model();
    mixed.box({ size: [1, 1, 1] });
    mixed.tag(sel.facing('+y'), 'hidden');
    mixed.tag(sel.facing('-y'), 'hero');
    mixed.uv.project({ mode: 'planar', axis: 'y', scale: 1 });
    const r2 = pack(mixed, { parts: { hero: 2, hidden: 0.5 } });
    expect(warnings(r2).some((w) => /several density parts/.test(w))).toBe(true);
  });

  it('names the density that fits when the target does not (falsifier: the old error had no number)', () => {
    const m = parts();
    pack(m, { target: 5000, tolerance: 0.1 });
    expect(m.poisoned?.code).toBe('model-precondition');
    const achievable = (m.poisoned?.detail as { achievable: number }).achievable;
    expect(achievable).toBeGreaterThan(10);
    expect(achievable).toBeLessThan(4500);
    const again = parts();
    expect(pack(again, { target: achievable * 0.98 }).status).toBe('ok');
  });
});

describe('validate texelDensity parts (BK53)', () => {
  const R = 512;
  it('checks each part against target x multiplier: a uniform pack fails, the multiplied pack passes (falsifier)', () => {
    const uniform = parts();
    uniform.uv.pack({ resolution: R, padding: 4, density: { target: 60 } });
    const budget = { resolution: R, target: 60, tolerance: 0.05, parts: { hero: 2, hidden: 0.5 } };
    const flagged = uniform
      .validate({ texelDensity: budget })
      .issues.find((i) => i.code === 'texel-density');
    expect(flagged?.detail.outside).toBe(24);
    const rows = flagged?.detail.byPart as {
      part: string | null;
      target: number;
      outside: number;
    }[];
    expect(rows.map((r) => [r.part, r.target, r.outside])).toEqual([
      ['hero', 120, 12],
      ['hidden', 30, 12],
      [null, 60, 0],
    ]);
    const tuned = parts();
    tuned.uv.pack({
      resolution: R,
      padding: 4,
      density: { target: 60, parts: { hero: 2, hidden: 0.5 } },
    });
    expect(tuned.validate({ texelDensity: budget }).issues.map((i) => i.code)).not.toContain(
      'texel-density',
    );
    // Without parts the check is the old one.
    expect(
      tuned
        .validate({ texelDensity: { resolution: R, target: 60, tolerance: 0.05 } })
        .issues.find((i) => i.code === 'texel-density')?.detail.byPart,
    ).toBeUndefined();
  });

  it('reports a malformed parts table instead of throwing', () => {
    const m = parts();
    m.uv.pack({ resolution: R, padding: 4 });
    const issue = m
      .validate({ texelDensity: { resolution: R, target: 60, parts: { hero: 0 } } })
      .issues.find((i) => i.code === 'texel-density');
    expect(issue?.detail.check).toBe('bad-parts');
    const wide = m
      .validate({ texelDensity: { resolution: R, target: 60, parts: { hero: 1e9 } } })
      .issues.find((i) => i.code === 'texel-density');
    expect(wide?.detail.check).toBe('bad-parts');
  });

  it('an empty parts table adds no byPart row (same finding as parts omitted)', () => {
    const m = parts();
    m.uv.pack({ resolution: R, padding: 4 });
    const find = (table?: Record<string, number>) =>
      m
        .validate({
          texelDensity: {
            resolution: R,
            target: 400,
            tolerance: 0.05,
            ...(table === undefined ? {} : { parts: table }),
          },
        })
        .issues.find((i) => i.code === 'texel-density');
    const plain = find();
    expect(plain?.detail.outside).toBeGreaterThan(0);
    expect(find({})?.detail.byPart).toBeUndefined();
    expect(find({})?.detail).toEqual(plain?.detail);
  });
});

describe('repack-only (BK65): uv.pack on existing charts', () => {
  const R = 256;
  const shapes = (m: Model) => {
    const measured = measureUv(m.editMesh);
    if (!measured.ok) throw measured.error;
    return {
      flipped: measured.value.flipped,
      islands: measured.value.islands.map((x) => [x.stretchL2, x.areaDistortion]),
    };
  };

  it('keeps every chart shape through any resolution, padding and part table (falsifier: re-unwrapping changes shapes)', () => {
    const m = parts();
    m.uv.pack({ resolution: R, padding: 2, method: 'raster' });
    const before = shapes(m);
    expect(before.flipped).toBe(0);
    for (const again of [
      { resolution: 1024, padding: 8 },
      { resolution: 128, padding: 1, method: 'raster' as const },
      { resolution: 512, padding: 4, density: { parts: { hero: 3, hidden: 0.25 } } },
    ]) {
      expect(m.uv.pack(again).status).toBe('ok');
      const after = shapes(m);
      expect(after.flipped).toBe(0);
      expect(after.islands).toHaveLength(before.islands.length);
      for (const [i, x] of after.islands.entries()) {
        expect(x[0]).toBeCloseTo((before.islands[i] as number[])[0] as number, 4);
        expect(x[1]).toBeCloseTo((before.islands[i] as number[])[1] as number, 4);
      }
    }
  });

  it('repack reaches the same density table as a direct pack, and is deterministic', () => {
    const options = { resolution: 512, padding: 4, density: { parts: { hero: 2 } } };
    const direct = parts();
    const directUtil = infoOf(direct.uv.pack(options)).metrics.rectUtilization as number;
    const repacked = parts();
    repacked.uv.pack({ resolution: 128, padding: 2 });
    const repackUtil = infoOf(repacked.uv.pack(options)).metrics.rectUtilization as number;
    const sorted = (m: Model) => densities(m, 512, 'hero').sort((a, b) => a - b);
    for (const [i, d] of sorted(repacked).entries())
      expect(d).toBeCloseTo(sorted(direct)[i] as number, 3);
    expect(Math.abs(repackUtil - directUtil)).toBeLessThan(0.02);
    const twice = parts();
    twice.uv.pack({ resolution: 128, padding: 2 });
    twice.uv.pack(options);
    expect(bytes(twice)).toBe(bytes(repacked));
  });

  it('normalize: false keeps the relative scales of the previous pack, density hits the mean target', () => {
    const m = parts();
    m.uv.pack({ resolution: R, padding: 2, density: { parts: { hero: 2, hidden: 0.5 } } });
    const ratio = (x: Model) => mean(densities(x, R, 'hero')) / mean(densities(x, R, 'hidden'));
    expect(ratio(m)).toBeCloseTo(4, 3);
    const report = m.uv.pack({
      resolution: 512,
      padding: 4,
      normalize: false,
      density: { target: 40 },
    });
    expect(report.status).toBe('ok');
    expect(infoOf(report).metrics.texelsPerMeter).toBeCloseTo(40, 3);
    expect(mean(densities(m, 512, 'hero')) / mean(densities(m, 512, 'hidden'))).toBeCloseTo(4, 3);
    // Falsifier: normalize keeps no memory and flattens the table.
    const flat = parts();
    flat.uv.pack({ resolution: R, padding: 2, density: { parts: { hero: 2, hidden: 0.5 } } });
    flat.uv.pack({ resolution: 512, padding: 4 });
    expect(mean(densities(flat, 512, 'hero')) / mean(densities(flat, 512, 'hidden'))).toBeCloseTo(
      1,
      3,
    );
  });
});
