import { describe, expect, it } from 'vitest';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';
import {
  bakeTrimSheet,
  type TrimModule,
  type TrimRegion,
  type TrimSheet,
  type TrimSheetOptions,
  trimBakeKey,
  trimReport,
  trimSheet,
} from '../trim';

function sheetOf(options: TrimSheetOptions): TrimSheet {
  const r = trimSheet(options);
  if (!r.ok) throw r.error;
  return r.value;
}

function info(report: OpReport): {
  metrics: Record<string, number>;
  instances: { region: string; deviation: number; mirrored: boolean; turn: number }[];
} {
  const d = report.diagnostics?.find((x) => x.severity === 'info');
  if (d === undefined) throw new Error(`${report.op}: ${report.error?.message}`);
  return d.detail as never;
}

const warnings = (report: OpReport) =>
  (report.diagnostics ?? []).filter((d) => d.severity === 'warn').map((d) => d.message);

/** A w x h quad in the plane z = 0 with its lower-left corner at (x, y), facing +z. */
function quad(m: Model, x: number, y: number, w: number, h: number, tag: string): void {
  m.polygon({
    points: [
      [x, y, 0],
      [x + w, y, 0],
      [x + w, y + h, 0],
      [x, y + h, 0],
    ],
    tag,
  });
}

const bolt = (params: Record<string, number>): TrimModule => ({
  id: 'bolt',
  size: [0.13, 0.13],
  signature: { id: 'test.bolt', params },
  source: {
    kind: 'analytic',
    height: (s, t) => (Math.hypot(s - 0.065, t - 0.065) < 0.04 ? 0.01 : 0),
  },
});

describe('trim dedupe', () => {
  it('merges modules of one canonical signature into one region; a different parameter misses', () => {
    const sheet = sheetOf({
      key: 'd',
      size: 256,
      density: 320,
      modules: [
        bolt({ d: 0.012, k: 0.0075 }),
        { ...bolt({ k: 0.0075, d: 0.0120001 }), id: 'bolt2' },
      ],
    });
    expect(sheet.regions.bolt2?.rect).toEqual(sheet.regions.bolt?.rect);
    expect(sheet.regions.bolt2?.key).toBe(sheet.regions.bolt?.key);
    expect(sheet.metrics.dedupeHits).toBe(1);
    expect(sheet.metrics.dedupeMisses).toBe(1);
    expect(sheet.metrics.regions).toBe(1);
    expect(sheet.members.find((m) => m.region === 'bolt2')?.alias).toBe('bolt');
    const other = sheetOf({
      key: 'd',
      size: 256,
      density: 320,
      modules: [bolt({ d: 0.012, k: 0.0075 }), { ...bolt({ d: 0.0121, k: 0.0075 }), id: 'bolt2' }],
    });
    expect(other.metrics.dedupeHits).toBe(0);
    expect(other.regions.bolt2?.rect).not.toEqual(other.regions.bolt?.rect);
  });

  it('rejects one signature declared twice differently (the falsifier: it would miss the dedupe)', () => {
    const r = trimSheet({
      key: 'd',
      size: 256,
      density: 320,
      modules: [bolt({ d: 0.012 }), { ...bolt({ d: 0.012 }), id: 'bolt2', size: [0.2, 0.2] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });

  it('keys identical mesh details and flat swatches by content; the bake key follows content and settings', () => {
    const detail = model();
    detail.box({ size: [0.05, 0.05, 0.01], center: [0.0625, 0.0625, 0.005] });
    const modules: TrimModule[] = [
      { id: 'a', size: [0.125, 0.125], source: { kind: 'mesh', detail } },
      { id: 'b', size: [0.125, 0.125], source: { kind: 'mesh', detail: detail.snapshot() } },
      { id: 'c', size: [0.125, 0.125], source: { kind: 'flat', material: 'paint' } },
    ];
    const sheet = sheetOf({ key: 'm', size: 128, density: 256, modules });
    expect(sheet.metrics.dedupeHits).toBe(1);
    expect(sheet.regions.b?.rect).toEqual(sheet.regions.a?.rect);
    const settings = { maps: ['normal'] as const, samples: 1 as const, ao: { rays: 4 } };
    const key = trimBakeKey(sheet, settings);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(trimBakeKey(sheet, { ...settings, samples: 4 })).not.toBe(key);
    const baked = bakeTrimSheet(sheet, settings);
    if (!baked.ok) throw baked.error;
    expect(baked.value.report.cacheKey).toBe(key);
    expect(baked.value.report.sources).toEqual({ a: 'mesh', b: 'mesh', c: 'flat' });
    const unkeyed = sheetOf({
      key: 'm',
      size: 128,
      density: 256,
      modules: [{ id: 'f', size: [0.1, 0.1], source: { kind: 'analytic', height: () => 0 } }],
    });
    expect(trimBakeKey(unkeyed, settings)).toBeUndefined();
  });
});

describe('trim families: scale buckets and variants', () => {
  const SQ = Math.SQRT2;
  const family = sheetOf({
    key: 'f',
    size: 512,
    density: 256,
    modules: [
      {
        id: 'bolt',
        size: [0.125, 0.125],
        scales: [1 / SQ, 1, SQ],
        variants: 2,
        source: ({ variant, scale }) => ({
          kind: 'analytic',
          height: (s, t) =>
            Math.hypot(s - 0.0625 * scale, t - 0.0625 * scale) < 0.03 * scale
              ? 0.005 * (variant + 1)
              : 0,
        }),
      },
      { id: 'plain', size: [0.125, 0.125] },
    ],
  });
  const members = family.families.bolt as readonly TrimRegion[];

  it('expands buckets x variants into regions of one density; the base member keeps the module id', () => {
    expect(members.map((r) => r.id)).toEqual([
      'bolt.s0v0',
      'bolt.s0v1',
      'bolt',
      'bolt.s1v1',
      'bolt.s2v0',
      'bolt.s2v1',
    ]);
    for (const r of members) {
      expect(r.family).toBe('bolt');
      expect(r.size[0]).toBeCloseTo(0.125 * r.scale, 12);
      expect(Math.abs(r.density[0] / 256 - 1)).toBeLessThan(0.03);
    }
    expect(family.metrics.families).toBe(2);
    const plain = trimSheet({
      key: 'f',
      size: 256,
      density: 256,
      modules: [{ id: 'p', size: [0.1, 0.1], variants: 2 }],
    });
    expect(plain.ok).toBe(false);
  });

  it('maps every instance to its nearest bucket: density stays within 19 % from 0.6x to 1.7x (falsifier: one bucket)', () => {
    const m = model();
    const sizes = [0.6, 0.7, 0.85, 1, 1.2, 1.41, 1.7];
    for (const [i, k] of sizes.entries()) quad(m, i * 0.5, 0, 0.125 * k, 0.125 * k, `q${i}`);
    const r = m.uv.trim({ faces: sel.all(), region: members });
    expect(r.status).toBe('ok');
    const { metrics, instances } = info(r);
    expect(metrics.instances).toBe(7);
    expect(metrics.densityDeviation).toBeLessThanOrEqual(2 ** 0.25 - 1 + 0.03);
    expect(new Set(instances.map((x) => x.region.split('.')[0]))).toEqual(new Set(['bolt']));
    const single = model();
    for (const [i, k] of sizes.entries()) quad(single, i * 0.5, 0, 0.125 * k, 0.125 * k, `q${i}`);
    const one = single.uv.trim({
      faces: sel.all(),
      region: members.filter((x) => x.scale === 1),
      fit: { u: 'fit', v: 'fit' },
    });
    expect(info(one).metrics.densityDeviation).toBeGreaterThan(0.6);
    expect(warnings(one).join()).toMatch(/deviate more than 10%/);
  });

  it('picks variants, turns, mirrors and hash colors per instance deterministically', () => {
    const build = (seed: number) => {
      const m = model();
      for (let i = 0; i < 24; i++)
        quad(m, (i % 6) * 0.3, Math.floor(i / 6) * 0.3, 0.125, 0.125, `q${i}`);
      const r = m.uv.trim({
        faces: sel.all(),
        region: members.filter((x) => x.scale === 1),
        variation: {
          rotate: 'hash',
          mirror: 'hash',
          seed,
          hashTo: true,
        },
      });
      return { m, r };
    };
    const { m, r } = build(0);
    expect(r.status).toBe('ok');
    expect(warnings(r)).toEqual([]);
    const { metrics, instances } = info(r);
    expect(metrics.regionsUsed).toBe(2);
    expect(metrics.mirrored).toBeGreaterThan(3);
    expect(metrics.mirrored).toBeLessThan(21);
    expect(metrics.turned).toBeGreaterThan(3);
    expect(metrics.densityDeviation).toBeLessThan(1e-9);
    const again = build(0);
    expect(info(again.r).instances).toEqual(instances);
    expect(info(build(7).r).instances).not.toEqual(instances);
    const alphas = new Set<number>();
    const mesh = m.editMesh;
    for (const f of sel.tag('q3').evaluate(mesh)) {
      for (const h of mesh.faceHalves(f)) alphas.add(mesh.corner('color', h)?.[3] as number);
    }
    expect(alphas.size).toBe(1);
    const all = new Set(
      sel
        .all()
        .evaluate(mesh)
        .map((f) => mesh.corner('color', mesh.faceHalves(f)[0] as number)?.[3]),
    );
    expect(all.size).toBeGreaterThan(20);
    const bad = model();
    quad(bad, 0, 0, 0.125, 0.125, 'a');
    bad.uv.trim({ faces: sel.all(), region: members, variation: { variant: 5 } });
    expect(bad.poisoned?.code).toBe('model-invalid-argument');
    const mixed = model();
    quad(mixed, 0, 0, 0.125, 0.125, 'a');
    mixed.uv.trim({
      faces: sel.all(),
      region: [members[0] as TrimRegion, family.regions.plain as TrimRegion],
    });
    expect(mixed.poisoned?.code).toBe('model-invalid-argument');
  });

  it('bakes each family member from its own source (variant heights differ, aliases bake once)', () => {
    const baked = bakeTrimSheet(family, { maps: ['height'], samples: 1, cage: { offset: 0.02 } });
    if (!baked.ok) throw baked.error;
    const height = baked.value.textures.height?.data as Uint8Array;
    const centerHeight = (r: TrimRegion) => {
      const [x, y, w, h] = r.rect;
      return height[((y + (h >> 1)) * 512 + x + (w >> 1)) * 4] as number;
    };
    const v0 = centerHeight(family.regions.bolt as TrimRegion);
    const v1 = centerHeight(family.regions['bolt.s1v1'] as TrimRegion);
    expect(v1 - 128).toBeCloseTo(2 * (v0 - 128), -1);
    expect(v0).toBeGreaterThan(128);
  });
});

describe('trimReport', () => {
  const PILOT: TrimModule[] = [
    { id: 'fan', size: [1.96, 1.96] },
    { id: 'louvre', size: [1.2, 0.96] },
    { id: 'mullion', size: [0.5, 1.3] },
    { id: 'recess', size: [0.1, 0.1] },
    { id: 'bolt', size: [0.13, 0.13] },
    { id: 'rib', size: [0.1, 0.35] },
    { id: 'clamp', size: [0.72, 0.12] },
  ];
  const sheet = sheetOf({
    key: 'kitwall',
    size: 1024,
    density: 320,
    padding: 8,
    inset: 0,
    modules: PILOT,
  });

  /** A C-400-like wall: 40 fans, louvres, mullions, 160 bolts, ribs and clamps, mapped metric. */
  function wall(variation: boolean): Model {
    const m = model();
    const put = (id: string, count: number, w: number, h: number) => {
      for (let i = 0; i < count; i++)
        quad(m, i * (w + 0.5), PILOT.findIndex((x) => x.id === id) * 3, w, h, id);
      m.uv.trim({
        faces: sel.tag(id),
        region: sheet.regions[id] as TrimRegion,
        axis: [1, 0, 0],
        ...(variation ? { variation: { rotate: 'hash' as const, mirror: 'hash' as const } } : {}),
      });
    };
    put('fan', 40, 1.96, 1.96);
    put('louvre', 12, 1.2, 0.96);
    put('mullion', 20, 0.5, 1.3);
    put('bolt', 160, 0.13, 0.13);
    put('rib', 10, 0.1, 0.35);
    put('clamp', 12, 0.72, 0.12);
    quad(m, 0, -5, 3, 3, 'untrimmed');
    m.uv.project({ faces: sel.tag('untrimmed'), mode: 'planar', axis: 'z', scale: 100 });
    return m;
  }

  it('counts 40 fans at the pilot coverage 0.565, flags clones and the unused recess, and prices R9', () => {
    const m = wall(false);
    expect(m.poisoned).toBeUndefined();
    const r = trimReport(sheet, [m], { replaced: { fan: 350, bolt: 20 } });
    if (!r.ok) throw r.error;
    const fan = r.value.regions.find((x) => x.id === 'fan');
    expect(fan?.instances).toBe(40);
    expect(fan?.utilization).toBeCloseTo(1, 2);
    expect(fan?.densitySpread).toBeLessThan(1e-3);
    expect(fan?.scaleRange[0]).toBeCloseTo(1, 2);
    expect(r.value.sheet.coverage).toBeCloseTo(0.5656, 3);
    expect(r.value.sheet.used).toBeCloseTo(0.5656 - (32 * 32) / (1024 * 1024), 2);
    expect(r.value.sheet.instances).toBe(254);
    expect(r.value.sheet.outside).toBe(1);
    expect(r.value.sheet.unusedRegions).toEqual(['recess']);
    const fans = r.value.families.find((x) => x.id === 'fan');
    expect(fans?.clones).toBe(true);
    // the fan region breaks even at about 31 instances; 40 are worth it.
    expect(fans?.breakEven?.instancesNeeded).toBe(31);
    expect(fans?.breakEven?.worthIt).toBe(true);
    expect(r.value.families.find((x) => x.id === 'bolt')?.breakEven?.instancesNeeded).toBe(3);
    expect(r.value.pass).toBe(false);
    expect(r.value.issues.map((i) => i.code)).toEqual(['trim-clones', 'trim-unused']);
    expect(r.value.issues[1]?.detail.regions).toEqual(['recess']);
    const varied = trimReport(sheet, [wall(true)]);
    if (!varied.ok) throw varied.error;
    expect(varied.value.families.find((x) => x.id === 'fan')?.clones).toBe(false);
    expect(varied.value.regions.find((x) => x.id === 'fan')?.mirrored).toBeGreaterThan(0);
    const few = trimReport(sheet, [m], { replaced: { fan: 100 } });
    if (!few.ok) throw few.error;
    expect(few.value.issues.map((i) => i.code)).toContain('trim-break-even');
  });
});
