import { generatePackMeshLods } from '@forgeax/engine-import/mesh-lod-generator';
import { type AssetsJob, type BakeMapKind, bakeMapsParallel, createMeshJobCooker, mipChain, model, sel } from '@forgeax/engine-modeling';
import type { PackOutput } from '@forgeax/engine-pack/source';
import { type Asset, ok, type TextureAsset } from '@forgeax/engine-types';
import { composeVariant, prepareSet } from '../scifi-mech/maps.ts';
import { bakeSettings, buildTurretAsset, LOW_NORMALS, UV_ATLAS, unwrapLow } from './asset.ts';
import { check } from './kit.ts';

/**
 * C-600 turret as a Pack job: one low mesh per rig part (all share the one atlas and one slot), a
 * LOD chain per mesh, and the baked and composed normal, albedo and ORM maps with packed mip chains.
 * Rebuilds the low and its UV atlas from source, bakes the high into it and composes the wear layer.
 * The emissive map of the bake is all zero (no emissive slot) and is not shipped.
 */
export const TURRET = {
  key: 'c600-turret',
  /** Rig part meshes `mesh/c600-turret.<part>`, selected by the part tag of the low. */
  parts: ['barbette', 'house', 'cradle', 'mantlet', 'apron', 'barrel-port', 'barrel-starboard'] as const,
  slot: 'turret',
  maps: ['normal', 'albedo', 'orm'] as const,
  bakeBudget: 1e15,
} as const;
export type TurretPart = (typeof TURRET.parts)[number];

export const QUALITIES = {
  page: { resolution: UV_ATLAS.resolution, samples: 4 as const, aoRays: 16, workers: 8 },
  full: { resolution: UV_ATLAS.resolution * 2, samples: 4 as const, aoRays: 16, workers: 8 },
} as const;
export type Quality = keyof typeof QUALITIES;
export const QUALITY_NAMES = Object.keys(QUALITIES) as Quality[];
export const DEFAULT_QUALITY: Quality = 'page';

export interface TurretParams {
  readonly quality: Quality;
  [key: string]: string;
}

/** LOD levels of every part mesh (fine to coarse; the error budget is relative to the part extent). */
export const TURRET_LODS = {
  maxError: 0.004,
  levels: [
    { triangleRatio: 0.5, screenCoverage: 0.5 },
    { triangleRatio: 0.25, screenCoverage: 0.2, maxError: 0.015 },
    { triangleRatio: 0.1, screenCoverage: 0.08, maxError: 0.04 },
  ],
} as const;

export const meshKey = (part: string) => `mesh/${TURRET.key}.${part}`;
export const textureKey = (map: (typeof TURRET.maps)[number]) => `texture/${TURRET.key}-${map}`;
export const materialKey = (kind: 'baked' | 'plain') => `material/${TURRET.key}-${kind}`;
export const lodKeys = (key: string) => TURRET_LODS.levels.map((_, i) => `${key}/lod${i + 1}`);

/** Output keys of the job, listed by the Pack without running it (the cooker fails a stale list). */
export const TURRET_OUTPUTS: readonly string[] = [
  ...TURRET.parts.flatMap((p) => [meshKey(p), ...lodKeys(meshKey(p))]),
  ...TURRET.maps.map(textureKey),
];

function fail(what: string, error: { code: string; expected: string }): never {
  throw new Error(`${what}: ${error.code} ${error.expected}`);
}

const turretJob: AssetsJob<TurretParams> = {
  kind: 'assets',
  name: `${TURRET.key}.build`,
  build: async (params, { packageId, cache }) => {
    const q = QUALITIES[params.quality] ?? QUALITIES[DEFAULT_QUALITY];
    const N = q.resolution;
    const { low, high } = buildTurretAsset();
    unwrapLow(low);
    const { bakeWorkers } = await import('@forgeax/engine-modeling/tools');
    const baked = await bakeMapsParallel({
      base: low.snapshot(),
      detail: high.snapshot(),
      ...bakeSettings(q.aoRays),
      resolution: N,
      samples: q.samples,
      budget: TURRET.bakeBudget,
      ...(cache === undefined ? {} : { cache }),
    } as never, bakeWorkers({ workers: q.workers }));
    if (!baked.ok) return fail('bake turret', baked.error);
    const level0 = (map: string) => (baked.value.textures[map as BakeMapKind]?.data as Uint8Array).subarray(0, N * N * 4);
    const maps = Object.fromEntries(['normal', 'curvature', 'materialId', 'baseColor', 'ormh', 'emissive'].map((k) => [k, level0(k)])) as Record<'normal' | 'curvature' | 'materialId' | 'baseColor' | 'ormh' | 'emissive', Uint8Array>;
    const exported = low.toMesh({ normals: LOW_NORMALS });
    if (!exported.ok) return fail('export low', exported.error);
    const mesh = exported.value.mesh as unknown as { attributes: { position: Float32Array; normal: Float32Array; uv: Float32Array }; indices: { data: ArrayLike<number> } | ArrayLike<number> };
    const indices = 'data' in (mesh.indices as object) ? (mesh.indices as { data: ArrayLike<number> }).data : (mesh.indices as ArrayLike<number>);
    const prepared = prepareSet(N, { position: mesh.attributes.position, normal: mesh.attributes.normal, uv: mesh.attributes.uv, indices }, maps, baked.value.provenance.materials);
    const { albedo, orm } = composeVariant(prepared, 'art');

    const out: Record<string, PackOutput> = {};
    for (const part of TURRET.parts) {
      const piece = model({ budget: { work: 4e9 } });
      check(piece.append(low.snapshot()), `append ${part}`);
      const own = part === 'barrel-port' ? sel.tag(part).minus(sel.tag('barrel-starboard')) : sel.tag(part);
      check(piece.delete(sel.all().minus(own)), `isolate ${part}`);
      check(piece.assign(sel.all(), TURRET.slot), `slot ${part}`);
      const finished = piece.finish({ key: `${TURRET.key}.${part}`, normals: LOW_NORMALS });
      if (!finished.ok) return fail(`finish ${part}`, finished.error);
      Object.assign(out, finished.value);
    }
    const requests = Object.fromEntries(TURRET.parts.map((p) => [meshKey(p), TURRET_LODS]));
    const lods = await generatePackMeshLods(packageId, out, requests as never);
    if (!lods.ok) return fail('lods', lods.error);
    const assets: Record<string, Asset> = { ...(lods.value.outputs as Record<string, Asset>) };

    const encode = (map: (typeof TURRET.maps)[number], layout: 'normal' | 'ormh' | 'color', data: Uint8Array, srgb: boolean) => {
      const level: TextureAsset = {
        kind: 'texture',
        format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
        colorSpace: srgb ? 'srgb' : 'linear',
        shape: { viewDimension: '2d', extent: { width: N, height: N } },
        mips: { kind: 'none' },
        data,
      };
      const chain = mipChain(level, { layout });
      if (!chain.ok) fail(`mips ${map}`, chain.error);
      const packed = new Uint8Array(chain.value.levels.reduce((n, l) => n + l.byteLength, 0));
      let at = 0;
      for (const l of chain.value.levels) {
        packed.set(l, at);
        at += l.byteLength;
      }
      assets[textureKey(map)] = { ...level, mips: { kind: 'packed', levelCount: chain.value.levels.length }, data: packed };
    };
    encode('normal', 'normal', maps.normal, false);
    encode('albedo', 'color', albedo, true);
    encode('orm', 'ormh', orm, false);
    return ok(assets);
  },
};

export const TURRET_JOBS: readonly AssetsJob<TurretParams>[] = [turretJob];
export const createTurretCooker = () => createMeshJobCooker(TURRET_JOBS, { timeoutMs: 3_600_000 });
export const turretJobOf = (): AssetsJob<TurretParams> => turretJob;
