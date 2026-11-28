// A scene of delivered assets placed many times, measured as one serialisable manifest and checked against a
// scene-level output profile. Plain data in, plain data out: meshes are referenced by asset id and never embedded,
// and no Engine type is read. The manifest describes what a renderer would draw; it places, culls and loads nothing.
import { err, type MeshAsset, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import { assetStats, textureBytes } from './asset-budget';
import type { DeliveredAsset } from './deliver';
import { hypot3 } from './dmath';
import type { ModelingError } from './errors';
import type { Tuple3 } from './geom';
import type { Issue } from './report';

export type Quat = readonly [number, number, number, number];

export interface Bounds3 {
  readonly min: Tuple3;
  readonly max: Tuple3;
}

export interface SceneAsset {
  readonly id: string;
  readonly asset: Pick<DeliveredAsset, 'mesh' | 'lods' | 'textures'>;
  /** Camera distance (meters) at which LOD i+1 replaces LOD i; one per entry of `asset.lods`, strictly increasing. */
  readonly lodDistances?: readonly number[];
}

export interface ScenePlacement {
  readonly asset: string;
  /** Unique within the scene when given. */
  readonly name?: string;
  readonly position: Tuple3;
  /** Unit quaternion xyzw; default identity. Never normalised by the kernel. */
  readonly rotation?: Quat;
  /** Default 1. A negative component mirrors the placement. */
  readonly scale?: number | Tuple3;
}

export interface SceneOutputProfile {
  /** All placements at LOD0, worst case. */
  readonly maxTriangles: number;
  readonly maxDrawCalls: number;
  /** True when the target renderer draws all placements of one asset material in one call. */
  readonly instancing: boolean;
  /** Unique textures, RGBA8 with mips. */
  readonly maxTextureBytes: number;
  /** Unique meshes including LODs, quantized estimate. */
  readonly maxMeshBytes: number;
}

export type SceneOutputProfileId = 'mobile-scene';

/**
 * Proposal values, not calibrated on devices or frame budgets; revise them against measured device evidence before
 * they gate anything. Same status as the asset output profiles.
 */
export const SCENE_OUTPUT_PROFILES: Readonly<Record<SceneOutputProfileId, SceneOutputProfile>> = {
  'mobile-scene': {
    maxTriangles: 150_000,
    maxDrawCalls: 60,
    instancing: false,
    maxTextureBytes: 64 * 1024 * 1024,
    maxMeshBytes: 8 * 1024 * 1024,
  },
};

export type SceneManifestErrorCode =
  | 'scene-no-assets'
  | 'scene-no-placements'
  | 'scene-duplicate-asset-id'
  | 'scene-duplicate-placement-name'
  | 'scene-unknown-asset'
  | 'scene-invalid-position'
  | 'scene-invalid-rotation'
  | 'scene-invalid-scale'
  | 'scene-invalid-lod-distances'
  | 'scene-invalid-profile'
  | 'scene-asset-unmeasurable';

/** Expected failure of a manifest: a value, never a throw. `detail` names the offending input. */
export interface SceneManifestError {
  readonly code: SceneManifestErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export const SCENE_MANIFEST_ERROR_HINTS: Readonly<Record<SceneManifestErrorCode, string>> = {
  'scene-no-assets': 'pass at least one delivered SceneAsset',
  'scene-no-placements':
    'pass at least one placement; a scene without placements draws nothing to check',
  'scene-duplicate-asset-id': 'give every SceneAsset a unique id; detail.id names the repeated one',
  'scene-duplicate-placement-name':
    'give named placements unique names, or omit the name; detail.name is the repeat',
  'scene-unknown-asset':
    'a placement must name the id of a SceneAsset in this scene; detail.asset is the missing id',
  'scene-invalid-position':
    'pass a finite [x, y, z] position in meters; detail.placement is its index',
  'scene-invalid-rotation':
    'pass a unit quaternion [x, y, z, w] whose length is 1 within 1e-6; the kernel does not normalise it, so normalise before the call',
  'scene-invalid-scale':
    'pass a finite, non-zero scale per axis; a negative component mirrors the placement',
  'scene-invalid-lod-distances':
    'pass one strictly increasing, positive distance (meters) per entry of asset.lods; omit it when the asset has no LODs',
  'scene-invalid-profile':
    'pass a built-in profile id or a profile whose limits are finite and non-negative, with a boolean instancing',
  'scene-asset-unmeasurable':
    'the asset mesh could not be measured; detail.cause names the modeling error, so repair the mesh and rebuild the manifest',
};

export type SceneBudgetCode =
  | 'scene-too-many-triangles'
  | 'scene-too-many-draw-calls'
  | 'scene-texture-bytes-over'
  | 'scene-mesh-bytes-over';

export type SceneWarningCode = 'scene-asset-unused';

const SCENE_BUDGET_HINTS: Readonly<Record<SceneBudgetCode, string>> = {
  'scene-too-many-triangles':
    'place fewer copies of the heavy asset, or give it a lighter LOD0; totals.trianglesLod0 is the measured sum',
  'scene-too-many-draw-calls':
    'merge material slots of the placed assets, or draw repeated placements with instancing; the measured count is per instance unless the profile sets instancing',
  'scene-texture-bytes-over':
    'share one texture between assets, or lower the texture resolution; each distinct texture is counted once',
  'scene-mesh-bytes-over':
    'drop unused LODs, use a coarser LOD0, or place fewer distinct assets; totals.meshBytes is the measured sum',
};

export interface SceneManifestLod {
  readonly triangles: number;
  readonly vertices: number;
  /** Camera distance (meters) from which this LOD is drawn; 0 for LOD0, index i for LOD i. */
  readonly distance: number;
}

export interface SceneManifestTexture {
  readonly kind: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface SceneManifestAsset {
  readonly id: string;
  /** LOD0 counts; the per-LOD rows follow in `lods`, LOD0 first. */
  readonly triangles: number;
  readonly vertices: number;
  readonly materials: number;
  readonly lods: readonly SceneManifestLod[];
  readonly textures: readonly SceneManifestTexture[];
  /** Local box enclosing every LOD of the mesh. */
  readonly bounds: Bounds3;
  readonly meshBytes: number;
}

export interface SceneManifestInstance {
  readonly asset: string;
  readonly name?: string;
  readonly position: Tuple3;
  readonly rotation: Quat;
  readonly scale: Tuple3;
  /** Odd number of negative scale components: the consumer must flip triangle winding. */
  readonly mirrored: boolean;
  /** World-space box of the transformed local box corners. */
  readonly bounds: Bounds3;
}

export interface SceneManifestTotals {
  readonly instances: number;
  readonly uniqueAssets: number;
  /** Sum over placements of the LOD0 triangles. */
  readonly trianglesLod0: number;
  /** Sum over placements of the last LOD's triangles: the lightest the scene can be drawn. */
  readonly trianglesLowest: number;
  /** Sum over unique placed assets of the LOD0 triangles: the geometry the scene holds once. */
  readonly trianglesUnique: number;
  /** Sum over placements of LOD0 material count: one draw per material per placement. */
  readonly drawCallsPerInstance: number;
  /** Sum over unique placed assets of LOD0 material count: one draw per material with instancing. */
  readonly drawCallsInstanced: number;
  readonly textureBytes: number;
  readonly meshBytes: number;
  readonly bounds: Bounds3;
}

export interface SceneManifest {
  readonly version: 1;
  readonly units: 'm';
  /** The built-in profile id, or 'custom' for a caller-declared profile. */
  readonly profile: string;
  /** Placed assets only, in input order. */
  readonly assets: readonly SceneManifestAsset[];
  /** One per placement, in input order. */
  readonly instances: readonly SceneManifestInstance[];
  readonly totals: SceneManifestTotals;
  /** A manifest over budget is still returned; `ok: false` is data. */
  readonly budget: { readonly ok: boolean; readonly issues: readonly Issue<SceneBudgetCode>[] };
  readonly warnings: readonly Issue<SceneWarningCode>[];
}

/** Side of the UV grid. Only triangle counts, vertex counts and bytes are read from the measurement, so it is minimal. */
const SCENE_UV_GRID = 8;
const UNIT_TOLERANCE = 1e-6;
const IDENTITY: Quat = [0, 0, 0, 1];

interface Level {
  readonly triangles: number;
  readonly vertices: number;
  readonly materials: number;
  readonly meshBytes: number;
  readonly bounds: Bounds3;
}

interface MeasuredTexture {
  readonly kind: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly object: TextureAsset;
}

interface Measured {
  readonly id: string;
  readonly levels: readonly Level[];
  readonly distances: readonly number[];
  readonly textures: readonly MeasuredTexture[];
  readonly bounds: Bounds3;
  readonly meshBytes: number;
}

function refuse(
  code: SceneManifestErrorCode,
  detail: Readonly<Record<string, unknown>>,
  expected: string,
): SceneManifestError {
  return { code, expected, hint: SCENE_MANIFEST_ERROR_HINTS[code], detail };
}

function boundsOf(position: Float32Array): Bounds3 {
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = position[i + k] as number;
      if (v < (min[k] as number)) min[k] = v;
      if (v > (max[k] as number)) max[k] = v;
    }
  }
  return { min, max };
}

function unionBounds(boxes: readonly Bounds3[]): Bounds3 {
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, b.min[k] as number);
      max[k] = Math.max(max[k] as number, b.max[k] as number);
    }
  }
  return { min, max };
}

function measureMesh(id: string, mesh: MeshAsset): Result<Level, ModelingError> {
  const stats = assetStats([{ id, mesh }], { uvGridSize: SCENE_UV_GRID });
  if (!stats.ok) return stats;
  return ok({
    triangles: stats.value.triangles,
    vertices: stats.value.vertices,
    materials: stats.value.materials,
    meshBytes: stats.value.quantizedBytes,
    bounds: boundsOf(mesh.attributes.position as Float32Array),
  });
}

function validDistances(given: readonly number[] | undefined, lodCount: number): boolean {
  if (given === undefined) return lodCount === 0;
  if (given.length !== lodCount) return false;
  let previous = 0;
  for (const d of given) {
    if (!(Number.isFinite(d) && d > previous)) return false;
    previous = d;
  }
  return true;
}

function measureAsset(asset: SceneAsset): Result<Measured, SceneManifestError> {
  const { lods } = asset.asset;
  if (!validDistances(asset.lodDistances, lods.length)) {
    return err(
      refuse(
        'scene-invalid-lod-distances',
        {
          asset: asset.id,
          lods: lods.length,
          lodDistances: asset.lodDistances === undefined ? null : [...asset.lodDistances],
        },
        `one strictly increasing positive distance per LOD (${lods.length})`,
      ),
    );
  }
  const meshes = [asset.asset.mesh, ...lods];
  const levels: Level[] = [];
  for (let i = 0; i < meshes.length; i++) {
    const m = measureMesh(asset.id, meshes[i] as MeshAsset);
    if (!m.ok) {
      return err(
        refuse(
          'scene-asset-unmeasurable',
          { asset: asset.id, level: i, cause: m.error.code },
          `a measurable mesh at LOD ${i} of ${asset.id}`,
        ),
      );
    }
    levels.push(m.value);
  }
  const textures: MeasuredTexture[] = [];
  for (const [kind, tex] of Object.entries(asset.asset.textures)) {
    if (tex === undefined) continue;
    if (tex.shape.viewDimension !== '2d') {
      return err(
        refuse(
          'scene-asset-unmeasurable',
          { asset: asset.id, texture: kind, cause: 'texture-not-2d' },
          `a 2d texture for ${kind} of ${asset.id}`,
        ),
      );
    }
    const { width, height } = tex.shape.extent;
    textures.push({ kind, width, height, bytes: textureBytes(width, height, true), object: tex });
  }
  const distances = [0, ...(asset.lodDistances ?? [])];
  return ok({
    id: asset.id,
    levels,
    distances,
    textures,
    bounds: unionBounds(levels.map((l) => l.bounds)),
    meshBytes: levels.reduce((n, l) => n + l.meshBytes, 0),
  });
}

/** Rotates `v` by the unit quaternion `q` (xyzw): v + w t + q x t with t = 2 (q x v). */
function rotate(q: Quat, v: Tuple3): Tuple3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

/** World box of a local box under scale, then rotation, then translation: the box of the 8 transformed corners. */
function worldBounds(local: Bounds3, position: Tuple3, rotation: Quat, scale: Tuple3): Bounds3 {
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [local.min[0], local.max[0]]) {
    for (const y of [local.min[1], local.max[1]]) {
      for (const z of [local.min[2], local.max[2]]) {
        const r = rotate(rotation, [x * scale[0], y * scale[1], z * scale[2]]);
        for (let k = 0; k < 3; k++) {
          const p = (r[k] as number) + (position[k] as number);
          if (p < (min[k] as number)) min[k] = p;
          if (p > (max[k] as number)) max[k] = p;
        }
      }
    }
  }
  return { min, max };
}

function placementProblem(p: ScenePlacement, index: number): SceneManifestError | undefined {
  if (!p.position.every((v) => Number.isFinite(v))) {
    return refuse(
      'scene-invalid-position',
      { placement: index, position: [...p.position] },
      'a finite position',
    );
  }
  const q = p.rotation ?? IDENTITY;
  const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (!q.every((v) => Number.isFinite(v)) || Math.abs(length - 1) > UNIT_TOLERANCE) {
    return refuse(
      'scene-invalid-rotation',
      { placement: index, rotation: [...q], length: Number.isFinite(length) ? length : null },
      `a unit quaternion within ${UNIT_TOLERANCE}`,
    );
  }
  const s = p.scale ?? 1;
  const scale: readonly number[] = typeof s === 'number' ? [s, s, s] : s;
  if (!scale.every((v) => Number.isFinite(v) && v !== 0)) {
    return refuse(
      'scene-invalid-scale',
      { placement: index, scale: [...scale] },
      'a finite, non-zero scale on every axis',
    );
  }
  return undefined;
}

function sceneInstance(p: ScenePlacement, asset: Measured): SceneManifestInstance {
  const rotation: Quat = p.rotation ?? IDENTITY;
  const s = p.scale ?? 1;
  const scale: Tuple3 = typeof s === 'number' ? [s, s, s] : [s[0], s[1], s[2]];
  const negatives = scale.filter((v) => v < 0).length;
  return {
    asset: p.asset,
    ...(p.name === undefined ? {} : { name: p.name }),
    position: [p.position[0], p.position[1], p.position[2]],
    rotation: [rotation[0], rotation[1], rotation[2], rotation[3]],
    scale,
    mirrored: negatives % 2 === 1,
    bounds: worldBounds(asset.bounds, p.position, rotation, scale),
  };
}

function validProfile(limits: SceneOutputProfile): boolean {
  return (
    [limits.maxTriangles, limits.maxDrawCalls, limits.maxTextureBytes, limits.maxMeshBytes].every(
      (v) => Number.isFinite(v) && v >= 0,
    ) && typeof limits.instancing === 'boolean'
  );
}

function assetEntry(m: Measured): SceneManifestAsset {
  const [lod0] = m.levels;
  return {
    id: m.id,
    triangles: lod0?.triangles ?? 0,
    vertices: lod0?.vertices ?? 0,
    materials: lod0?.materials ?? 0,
    lods: m.levels.map((l, i) => ({
      triangles: l.triangles,
      vertices: l.vertices,
      distance: m.distances[i] ?? 0,
    })),
    textures: m.textures.map((t) => ({
      kind: t.kind,
      width: t.width,
      height: t.height,
      bytes: t.bytes,
    })),
    bounds: m.bounds,
    meshBytes: m.meshBytes,
  };
}

/**
 * Measures a scene of delivered assets placed by `placements` and checks it against `profile` (an id or a
 * caller-declared profile). Expected failures of the input are `Result` errors; a measured budget violation is
 * returned as `budget.ok: false` with one issue per exceeded limit. Assets without a placement are measured and
 * reported in `warnings` but count toward no total.
 */
export function sceneManifest(
  assets: readonly SceneAsset[],
  placements: readonly ScenePlacement[],
  profile: SceneOutputProfileId | SceneOutputProfile,
): Result<SceneManifest, SceneManifestError> {
  const limits: SceneOutputProfile | undefined =
    typeof profile === 'string' ? SCENE_OUTPUT_PROFILES[profile] : profile;
  const profileName = typeof profile === 'string' ? profile : 'custom';
  if (limits === undefined || !validProfile(limits)) {
    return err(
      refuse('scene-invalid-profile', { profile: profileName }, 'a valid scene output profile'),
    );
  }
  if (assets.length === 0) return err(refuse('scene-no-assets', {}, 'at least one SceneAsset'));
  if (placements.length === 0) {
    return err(refuse('scene-no-placements', {}, 'at least one ScenePlacement'));
  }
  const ids = new Set<string>();
  for (const a of assets) {
    if (ids.has(a.id))
      return err(refuse('scene-duplicate-asset-id', { id: a.id }, 'unique asset ids'));
    ids.add(a.id);
  }
  const measured = new Map<string, Measured>();
  for (const a of assets) {
    const m = measureAsset(a);
    if (!m.ok) return m;
    measured.set(a.id, m.value);
  }
  const names = new Set<string>();
  const instances: SceneManifestInstance[] = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i] as ScenePlacement;
    const asset = measured.get(p.asset);
    if (asset === undefined) {
      return err(
        refuse(
          'scene-unknown-asset',
          { placement: i, asset: p.asset },
          'a SceneAsset id of this scene',
        ),
      );
    }
    if (p.name !== undefined) {
      if (names.has(p.name)) {
        return err(
          refuse(
            'scene-duplicate-placement-name',
            { placement: i, name: p.name },
            'unique placement names',
          ),
        );
      }
      names.add(p.name);
    }
    const bad = placementProblem(p, i);
    if (bad !== undefined) return err(bad);
    instances.push(sceneInstance(p, asset));
  }

  const used = assets.filter((a) => instances.some((inst) => inst.asset === a.id));
  const usedMeasured = used.map((a) => measured.get(a.id) as Measured);
  const entries = usedMeasured.map(assetEntry);
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const lod0 = (id: string): number => entryById.get(id)?.triangles ?? 0;
  const materialsOf = (id: string): number => entryById.get(id)?.materials ?? 0;
  const textureSeen = new Map<TextureAsset, number>();
  for (const m of usedMeasured) for (const t of m.textures) textureSeen.set(t.object, t.bytes);
  let trianglesLowest = 0;
  for (const inst of instances) {
    const e = entryById.get(inst.asset);
    trianglesLowest += e?.lods[e.lods.length - 1]?.triangles ?? 0;
  }
  const totals: SceneManifestTotals = {
    instances: instances.length,
    uniqueAssets: entries.length,
    trianglesLod0: instances.reduce((n, inst) => n + lod0(inst.asset), 0),
    trianglesLowest,
    trianglesUnique: entries.reduce((n, e) => n + e.triangles, 0),
    drawCallsPerInstance: instances.reduce((n, inst) => n + materialsOf(inst.asset), 0),
    drawCallsInstanced: entries.reduce((n, e) => n + e.materials, 0),
    textureBytes: [...textureSeen.values()].reduce((n, b) => n + b, 0),
    meshBytes: entries.reduce((n, e) => n + e.meshBytes, 0),
    bounds: unionBounds(instances.map((inst) => inst.bounds)),
  };

  const issues: Issue<SceneBudgetCode>[] = [];
  const over = (code: SceneBudgetCode, measuredValue: number, limit: number): void => {
    if (measuredValue <= limit) return;
    issues.push({
      code,
      severity: 'error',
      detail: {
        profile: profileName,
        measured: measuredValue,
        limit,
        hint: SCENE_BUDGET_HINTS[code],
      },
    });
  };
  over('scene-too-many-triangles', totals.trianglesLod0, limits.maxTriangles);
  over(
    'scene-too-many-draw-calls',
    limits.instancing ? totals.drawCallsInstanced : totals.drawCallsPerInstance,
    limits.maxDrawCalls,
  );
  over('scene-texture-bytes-over', totals.textureBytes, limits.maxTextureBytes);
  over('scene-mesh-bytes-over', totals.meshBytes, limits.maxMeshBytes);

  const warnings: Issue<SceneWarningCode>[] = assets
    .filter((a) => !used.includes(a))
    .map((a) => ({
      code: 'scene-asset-unused' as const,
      severity: 'warn' as const,
      detail: { asset: a.id, triangles: measured.get(a.id)?.levels[0]?.triangles ?? 0 },
    }));

  return ok({
    version: 1,
    units: 'm',
    profile: profileName,
    assets: entries,
    instances,
    totals,
    budget: { ok: issues.length === 0, issues },
    warnings,
  });
}

/**
 * Triangles drawn from `camera` when every placement picks its LOD by the distance to the centre of its world box:
 * the last LOD whose distance is at most that distance. A pure reading of the manifest.
 */
export function sceneTrianglesAt(manifest: SceneManifest, camera: Tuple3): number {
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));
  let total = 0;
  for (const inst of manifest.instances) {
    const asset = byId.get(inst.asset);
    if (asset === undefined) {
      throw new TypeError(`scene manifest instance names unknown asset ${inst.asset}`);
    }
    const centre = inst.bounds.min.map((v, k) => (v + (inst.bounds.max[k] as number)) / 2);
    const d = hypot3(
      (centre[0] as number) - camera[0],
      (centre[1] as number) - camera[1],
      (centre[2] as number) - camera[2],
    );
    let level = 0;
    for (let i = 1; i < asset.lods.length; i++) {
      if ((asset.lods[i]?.distance ?? Infinity) <= d) level = i;
    }
    total += asset.lods[level]?.triangles ?? 0;
  }
  return total;
}
