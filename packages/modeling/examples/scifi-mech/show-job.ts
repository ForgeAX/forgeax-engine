import { type AssetsJob, bakeMapsParallel, createMeshJobCooker, mipChain, type Model, model, sel } from '@forgeax/engine-modeling';
import { type Asset, ok, type TextureAsset } from '@forgeax/engine-types';
import { check, type Level, type Stage } from './kit.ts';
import { composeVariant, prepareSet, type SetBake } from './maps.ts';
import { GROUPS, type Group } from './mech.ts';
import { bakeSettings, buildGroup, buildSetBake, exportDump, HIGH_NORMALS, LOW_NORMALS, lowParts, partsOf, tris } from './pipeline.ts';

/**
 * C-410 show jobs: the heavy half of the page Pack (`scifi-mech.pack.ts`). Each job is an
 * `AssetsJob` whose outputs are ordinary assets under Pack output keys; the Pack publishes
 * them as `modeling-mesh-job` cook sources and the project's build plugin registers
 * `createMeshJobCooker(C410_JOBS)` (or `createC410Cooker()`) and the page runner's cooker set.
 *
 * - `c410.set1|2|3`: the set's low meshes (`mesh/c410-low.<part>`, one slot named after the set,
 *   one uv.auto atlas per set), the normal / AO / curvature / material-id bake of its detail
 *   source at 2048 texels and the composed maps `texture/c410-<set>-normal|albedo|orm|emissive`.
 * - `c410.high`: the detail source decimated to a preview (`mesh/c410-high`).
 */
/**
 * Quality profiles of the set bake. Keys, parts and materials are the same in both; only the
 * texture sizes and contents differ. `page` cold-cooks in minutes for the 3D page; `full` is the
 * evidence profile (2048 atlases, 9 samples per texel).
 */
export const QUALITIES = {
  page: { resolution: 1024, padding: 8, samples: 4 as const, aoRays: 8, halfMaps: 512, workers: 4 },
  full: { resolution: 2048, padding: 16, samples: 9 as const, aoRays: 16, halfMaps: 1024, workers: 4 },
} as const;
export type Quality = keyof typeof QUALITIES;
export const QUALITY_NAMES = Object.keys(QUALITIES) as Quality[];
export const DEFAULT_QUALITY: Quality = 'page';

/** Delivery KTX2 sizes by texture key, filled when FORGEAX_C410_KTX2=1 (reporting only; not shipped in the Pack). */
export const ktx2Bytes: Record<string, number> = {};
const REPORT_KTX2 = process.env.FORGEAX_C410_KTX2 === '1';

export const SHOW = {
  key: 'c410',
  sets: ['set1', 'set2', 'set3'] as const,
  /** Triangle budget of the decimated detail preview (the full detail source is 2.76 M). */
  previewTris: 300_000,
  /** Work units of one set bake (the default guards a Pack build). */
  bakeBudget: 1e15,
} as const;

/** Job parameters: the quality name (JSON, so the cook source carries it). */
export interface ShowParams {
  readonly quality: Quality;
  [key: string]: string;
}

export type ShowSet = (typeof SHOW.sets)[number];
export const SET_MAPS = ['normal', 'albedo', 'orm', 'emissive'] as const;
export const textureKey = (set: ShowSet, map: (typeof SET_MAPS)[number]) => `texture/${SHOW.key}-${set}-${map}`;
export const lowKey = (part: string) => `mesh/${SHOW.key}-low.${part}`;
export const HIGH_KEY = `mesh/${SHOW.key}-high`;

/** The parts of one set, in group order. */
export const setParts = (set: ShowSet): string[] => GROUPS.filter((g) => g.set === set).flatMap(partsOf);

function fail(what: string, error: { code: string; expected: string }): never {
  throw new Error(`${what}: ${error.code} ${error.expected}`);
}

/** Halve a linear RGBA8 map: each 2 x 2 block averaged (alpha is opaque). */
function downsample(map: Uint8Array, n: number): Uint8Array {
  const h = n / 2;
  const out = new Uint8Array(h * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < h; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += (map[((2 * y + (k >> 1)) * n + 2 * x + (k & 1)) * 4 + c] as number);
        out[(y * h + x) * 4 + c] = Math.round(sum / 4);
      }
      out[(y * h + x) * 4 + 3] = 255;
    }
  }
  return out;
}

function setJob(set: ShowSet): AssetsJob<ShowParams> {
  return {
    kind: 'assets',
    name: `${SHOW.key}.${set}`,
    build: async (params, { cache }) => {
      const q = QUALITIES[params.quality] ?? QUALITIES[DEFAULT_QUALITY];
      const N = q.resolution;
      const { low, detail, groups } = buildSetBake(set, N, q.padding);
      const out: Record<string, Asset> = {};
      for (const name of groups) Object.assign(out, lowParts(low, GROUPS.find((g) => g.name === name)!, `${SHOW.key}-low`));
      const { bakeWorkers, encodeKtx2 } = await import('@forgeax/engine-modeling/tools');
      const baked = await bakeMapsParallel({
        base: low.snapshot(),
        detail: detail.snapshot(),
        ...bakeSettings('after', q.aoRays),
        mips: false,
        resolution: N,
        samples: q.samples,
        budget: SHOW.bakeBudget,
        ...(cache === undefined ? {} : { cache }),
      }, bakeWorkers({ workers: q.workers }));
      if (!baked.ok) return fail(`bake ${set}`, baked.error);
      const level0 = (map: keyof SetBake) => (baked.value.textures[map]?.data as Uint8Array).subarray(0, N * N * 4);
      const maps: SetBake = { normal: level0('normal'), curvature: level0('curvature'), materialId: level0('materialId'), baseColor: level0('baseColor'), ormh: level0('ormh'), emissive: level0('emissive') };
      const atlas = exportDump(low, set, LOW_NORMALS);
      const prepared = prepareSet(N, atlas, maps, baked.value.provenance.materials);
      const { albedo, orm, emissive } = composeVariant(prepared, 'art');
      // Delivery: the kernel's one mip owner and layouts. Normals go to BC5 (RRRG), the rest to BC7-class
      // UASTC; ORM and emissive store half the atlas size (the texture budget).
      const sourceKey = baked.value.report.cacheKey;
      const half = q.halfMaps;
      const encode = async (map: (typeof SET_MAPS)[number], layout: 'normal' | 'ormh' | 'color', data: Uint8Array, size: number, srgb: boolean) => {
        const level: TextureAsset = {
          kind: 'texture',
          format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
          colorSpace: srgb ? 'srgb' : 'linear',
          shape: { viewDimension: '2d', extent: { width: size, height: size } },
          mips: { kind: 'none' },
          data,
        };
        // The Pack carries the raw packed mip chain of the kernel's one mip owner (the Pack texture producer
        // takes canonical raw layouts only); the KTX2 encode is reported, not shipped, until it accepts KTX2.
        const chain = mipChain(level, { layout });
        if (!chain.ok) fail(`mips ${set} ${map}`, chain.error);
        const packed = new Uint8Array(chain.value.levels.reduce((n, l) => n + l.byteLength, 0));
        let at = 0;
        for (const l of chain.value.levels) {
          packed.set(l, at);
          at += l.byteLength;
        }
        out[textureKey(set, map)] = { ...level, mips: chain.value.levels.length === 1 ? { kind: 'none' } : { kind: 'packed', levelCount: chain.value.levels.length }, data: packed };
        if (REPORT_KTX2) {
          const encoded = await encodeKtx2(level, { layout, sourceKey: `${sourceKey}:${map}` });
          if (encoded.ok) ktx2Bytes[textureKey(set, map)] = encoded.value.report.bytes;
        }
      };
      await encode('normal', 'normal', maps.normal, N, false);
      await encode('albedo', 'color', albedo, N, true);
      await encode('orm', 'ormh', downsample(orm, N), half, false);
      await encode('emissive', 'color', downsample(emissive, N), half, false);
      return ok(out);
    },
  };
}

/**
 * Detail stages of the preview: bevels, panels, vents and hydraulics. The rivet, bolt and fastener
 * stage is 1.8 M of the full source's 2.76 M triangles (thousands of tiny appended bodies that a
 * quadric decimation would only erase one by one), so the preview leaves it out.
 */
const PREVIEW_LEVEL: Level = { high: true, stages: new Set<Stage>(['form', 'bevel', 'panels', 'vents', 'hydraulics', 'markings']) };

/** The preview keeps no rims or material borders: they floor the collapse well above the budget. */
const RELAXED = { boundaries: false, sharp: false, labels: false, uvSeams: false, materials: false } as const;

/** A preview group: its fresh triangle count, the current ask, and the simplified model. */
interface PreviewGroup {
  readonly g: Group;
  readonly full: number;
  ask: number;
  m: Model;
  tris: number;
  floored: boolean;
}

function previewGroup(g: Group): { m: Model; tris: number } {
  const m = buildGroup(g, PREVIEW_LEVEL);
  check(m, m.uv.project({ mode: 'box', scale: 0.5 }));
  return { m, tris: tris(exportDump(m, g.name, HIGH_NORMALS)) };
}

/**
 * The preview detail of every group, simplified once from a fresh build to its share of the budget,
 * mirrored limbs included. Constraints floor some groups above their ask (rims and layered plates):
 * those keep their result and the remaining groups are rebuilt and asked for the leftover budget.
 */
const highJob: AssetsJob<ShowParams> = {
  kind: 'assets',
  name: `${SHOW.key}.high`,
  build: () => {
    const mult = (p: PreviewGroup) => (p.g.mirrored ? 2 : 1);
    const groups: PreviewGroup[] = GROUPS.map((g) => ({ g, ...previewGroup(g), full: 0, ask: 0, floored: false }));
    const fresh = groups.map((p) => p.tris);
    const target = SHOW.previewTris * 0.93;
    const total0 = groups.reduce((n, p, i) => n + (fresh[i] as number) * mult(p), 0);
    groups.forEach((p, i) => {
      (p as { full: number }).full = fresh[i] as number;
      p.ask = Math.max(64, Math.round((p.full * target) / total0));
    });
    for (let pass = 0; pass < 4; pass++) {
      for (const p of groups) {
        if (p.floored) continue;
        const built = pass === 0 ? { m: p.m, tris: p.tris } : previewGroup(p.g);
        p.m = built.m;
        if (p.full > p.ask) {
          check(p.m, p.m.simplify(undefined, { targetFaces: p.ask, preserve: RELAXED }), `simplify ${p.g.name}`);
          check(p.m, p.m.uv.project({ mode: 'box', scale: 0.5 }));
          p.tris = tris(exportDump(p.m, p.g.name, HIGH_NORMALS));
        }
        p.floored = p.tris > p.ask * 1.02;
      }
      const sum = groups.reduce((n, p) => n + p.tris * mult(p), 0);
      if (sum <= SHOW.previewTris * 0.97) break;
      const keptByFloor = groups.filter((p) => p.floored).reduce((n, p) => n + p.tris * mult(p), 0);
      const asked = groups.filter((p) => !p.floored).reduce((n, p) => n + p.ask * mult(p), 0);
      const room = target - keptByFloor;
      if (room <= 0 || asked <= 0) break;
      for (const p of groups) if (!p.floored) p.ask = Math.max(64, Math.round((p.ask * room) / asked));
    }
    const all = model();
    for (const { g, m } of groups) {
      if (g.mirrored) {
        // The right side is built at +X; faces that straddle the plane (a centered greeble) go before mirroring.
        const across = sel.inBox([-10, -10, -10], [-1e-6, 10, 10], { by: 'any' });
        if (m.count(across) > 0) check(m, m.delete(across));
        check(m, m.mirror({ axis: 'x' }));
      }
      check(all, all.append(m, { tag: g.name }), `append ${g.name}`);
    }
    const finished = all.finish({ key: `${SHOW.key}-high`, normals: HIGH_NORMALS });
    return finished.ok ? ok(finished.value) : fail('finish high', finished.error);
  },
};

export const SET_JOBS: readonly AssetsJob<ShowParams>[] = SHOW.sets.map(setJob);
/** Every show job, for the project's `createMeshJobCooker([...C410_JOBS])`. */
export const C410_JOBS: readonly AssetsJob<ShowParams>[] = [...SET_JOBS, highJob];

/** The `modeling-mesh-job` cooker of the show jobs; a set bake takes minutes, so its bound is an hour. */
export const createC410Cooker = () => createMeshJobCooker(C410_JOBS, { timeoutMs: 3_600_000 });

/** Output keys per job: the Pack lists them without running the job (the cooker fails a stale list). */
export const C410_OUTPUTS: Readonly<Record<ShowSet | 'high', readonly string[]>> = {
  set1: [...setParts('set1').map(lowKey), ...SET_MAPS.map((m) => textureKey('set1', m))],
  set2: [...setParts('set2').map(lowKey), ...SET_MAPS.map((m) => textureKey('set2', m))],
  set3: [...setParts('set3').map(lowKey), ...SET_MAPS.map((m) => textureKey('set3', m))],
  high: [HIGH_KEY],
};

export const jobOf = (name: ShowSet | 'high'): AssetsJob<ShowParams> => C410_JOBS.find((j) => j.name === `${SHOW.key}.${name}`) as AssetsJob<ShowParams>;
