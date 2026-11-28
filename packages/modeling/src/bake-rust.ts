import { err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import {
  bakeCorrespondRust,
  dilateAtlasRust,
  getModelingKernelWasm,
  RUST_BAKE_MAP_KINDS,
  type RustBakeCorrespondence,
  type RustBakeMapKindName,
  resolveBakeCageRust,
} from '@forgeax/modeling-kernel';
import {
  type AtlasGrid,
  type DilateAtlasOptions,
  type DilateAtlasResult,
  prepareAtlasDilation,
} from './compute/atlas-ts';
import {
  diagonalOf,
  emissiveScale,
  gridOf,
  type PreparedBake,
  type PreparedCagePlan,
  resolveSlot,
} from './compute/bake-ts';
import type {
  BackendOutput,
  BakeDirection,
  BakeGroupReport,
  BakeJobParams,
  BakeMapKind,
  BakeProvenance,
} from './compute/job';
import { cos } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { decodeSnapshot } from './fxem';
import { cross, normalize, sub, type Tuple3 } from './geom';

export type PackDilatedFn = (
  name: string,
  template: TextureAsset,
  rgbaF32: Float32Array,
  grid: AtlasGrid,
  mips: boolean | undefined,
  alphaCutoff: number | undefined,
) => Result<TextureAsset, ModelingError>;

export interface RustBakeCorrespondenceState {
  readonly corr: RustBakeCorrespondence;
  readonly prepared: PreparedBake;
  readonly provenance: BakeProvenance;
  readonly metrics: Readonly<Record<string, number>>;
}

function directionCode(dir: BakeDirection): number {
  if (dir === 'averaged') return 0;
  if (dir === 'shading') return 1;
  if (dir === 'face') return 2;
  return 3;
}

export function isRustBakeMapKind(kind: BakeMapKind): kind is RustBakeMapKindName {
  return kind in RUST_BAKE_MAP_KINDS;
}

export function shouldUseRustBake(
  backend: 'auto' | 'rust' | 'ts' | undefined,
  compute: 'auto' | 'ts' | 'native' | undefined,
): boolean {
  if (backend === 'ts' || compute === 'ts' || compute === 'native') return false;
  if (backend === 'rust') return true;
  return getModelingKernelWasm() !== undefined;
}

/**
 * Dilate 2D atlas `TextureAsset` buffers using the pure Rust kernel (`mk_atlas_dilate`).
 * Zero WebGPU dependency; preserves categorical channels verbatim and computes mip bleed.
 */
export function dilateAtlasWithRustKernel(
  options: DilateAtlasOptions,
  packTexture: PackDilatedFn,
): Result<DilateAtlasResult, ModelingError> {
  const prep = prepareAtlasDilation(options);
  if (!prep.ok) return prep;
  const { entries, grid, mask, owner, frame, gutter, protectMip, categorical } = prep.value;
  const texels = grid.w * grid.h;
  const buffers = entries.map(([, tex]) => {
    const out = new Float32Array(texels * 4);
    if (tex.format === 'r16unorm') {
      const view = new Uint16Array(tex.data.buffer, tex.data.byteOffset, texels);
      for (let i = 0; i < texels; i++) {
        out[i * 4] = (view[i] ?? 0) / 65535;
        out[i * 4 + 3] = 1;
      }
    } else {
      for (let i = 0; i < texels * 4; i++) {
        out[i] = (tex.data[i] ?? 0) / 255;
      }
    }
    return out;
  });

  const covered = Uint8Array.from(mask);
  const outOwner = Int32Array.from(owner);
  const res = dilateAtlasRust({
    width: grid.w,
    height: grid.h,
    wrapU: grid.u,
    wrapV: grid.v,
    gutter,
    protectMip,
    buffers,
    categorical: entries.map(([name]) => categorical.has(name)),
    covered,
    owner: outOwner,
    frame,
  });
  if (!res.ok) {
    return err(modelingError('model-internal', res.error.reason, { field: res.error.field }));
  }

  const textures: Record<string, TextureAsset> = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const buf = buffers[i];
    if (entry === undefined || buf === undefined) continue;
    const [name, tex] = entry;
    const packed = packTexture(name, tex, buf, grid, options.mips, options.alphaCutoff);
    if (!packed.ok) return packed;
    textures[name] = packed.value;
  }
  return ok({
    textures,
    bleed: res.value,
    backend: 'rust',
  });
}

function triangulateSnapshotBasic(bytes: Uint8Array): Result<
  {
    readonly pos: Float64Array;
    readonly norm: Float64Array;
    readonly idx: Uint32Array;
  },
  ModelingError
> {
  const decoded = decodeSnapshot(bytes);
  if (!decoded.ok) return decoded;
  const mesh = decoded.value;
  const posList: number[] = [];
  const normList: number[] = [];
  const idxList: number[] = [];
  for (const f of mesh.faces()) {
    const verts = mesh.faceVertices(f);
    if (verts.length < 3) continue;
    const [v0, v1, v2] = verts;
    if (v0 === undefined || v1 === undefined || v2 === undefined) continue;
    const p0 = mesh.position(v0);
    const p1 = mesh.position(v1);
    const p2 = mesh.position(v2);
    const fn = normalize(cross(sub(p1, p0), sub(p2, p0)));
    const baseV = posList.length / 3;
    for (const v of verts) {
      const p = mesh.position(v);
      posList.push(p[0], p[1], p[2]);
      normList.push(fn[0], fn[1], fn[2]);
    }
    for (let i = 1; i + 1 < verts.length; i++) {
      idxList.push(baseV, baseV + i, baseV + i + 1);
    }
  }
  return ok({
    pos: Float64Array.from(posList),
    norm: Float64Array.from(normList),
    idx: Uint32Array.from(idxList),
  });
}

/**
 * Refine group cage metrics (`offset`, `maxRay`, `steepArea`) using the Rust kernel's
 * `mk_bake_resolve_cage` while keeping TS preflight group partition & stray clustering.
 */
export function resolveBakeCagesWithRustKernel(
  baseBytes: Uint8Array,
  detailBytes: Uint8Array,
  params: BakeJobParams,
  plan: PreparedCagePlan,
): Result<PreparedCagePlan, ModelingError> {
  if (getModelingKernelWasm() === undefined) {
    return err(
      modelingError(
        'model-capability-unavailable',
        'Rust WASM modeling kernel is not initialized for resolveBakeCages',
      ),
    );
  }
  const bSoup = triangulateSnapshotBasic(baseBytes);
  if (!bSoup.ok) return bSoup;
  const dSoup = triangulateSnapshotBasic(detailBytes);
  if (!dSoup.ok) return dSoup;
  if (bSoup.value.idx.length === 0 || dSoup.value.idx.length === 0) return ok(plan);

  const cageRes = resolveBakeCageRust({
    basePos: bSoup.value.pos,
    baseNorm: bSoup.value.norm,
    baseIdx: bSoup.value.idx,
    detailPos: dSoup.value.pos,
    detailIdx: dSoup.value.idx,
    ...(typeof params.cage.offset === 'number' ? { offset: params.cage.offset } : {}),
    ...(typeof params.cage.maxRay === 'number' ? { maxRay: params.cage.maxRay } : {}),
    ...(typeof params.direction === 'object' && 'blend' in params.direction
      ? { dirMode: 'blend' as const, blendDistance: params.direction.blend }
      : typeof params.direction === 'string'
        ? { dirMode: params.direction }
        : { dirMode: 'face' as const }),
  });
  if (!cageRes.ok) {
    return err(
      modelingError('model-internal', cageRes.error.reason, { field: cageRes.error.field }),
    );
  }
  const g0 = plan.groups[0];
  if (plan.groups.length !== 1 || g0 === undefined) return ok(plan);
  return ok({
    ...plan,
    diagonal: cageRes.value.diagonal > 0 ? cageRes.value.diagonal : plan.diagonal,
    groups: [
      {
        ...g0,
        offset: typeof params.cage.offset === 'number' ? params.cage.offset : cageRes.value.offset,
        maxRay: typeof params.cage.maxRay === 'number' ? params.cage.maxRay : cageRes.value.maxRay,
        steep: cageRes.value.steepFraction,
      },
    ],
  });
}

/**
 * Run high-to-low surface correspondence once in pure Rust WASM (`mk_bake_correspond`),
 * keeping ownership of an opaque `RustBakeCorrespondence` handle.
 */
export function bakeCorrespondWithRustKernel(
  prepared: PreparedBake,
): Result<RustBakeCorrespondenceState, ModelingError> {
  const { params, groups, atlas, baker, triangles, encoding } = prepared;
  if (params.target !== 'texture' || atlas === undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'bakeCorrespond expects a texture-target bake with valid base uv0',
        { target: params.target },
      ),
    );
  }
  const { w: width, h: height } = gridOf(params);
  const samplesPerAxis = Math.max(1, Math.round(Math.sqrt(params.samples)));
  const bSurf = atlas.surface;
  const dSurf = baker.detail;
  const dTriCount = Math.floor(dSurf.indices.length / 3);
  const detailTriGroup = new Int32Array(dTriCount);
  for (let g = 0; g < groups.length; g++) {
    const map = groups[g]?.map;
    if (map === undefined) continue;
    for (let i = 0; i < map.length; i++) {
      const dt = map[i] ?? -1;
      if (dt >= 0 && dt < dTriCount) detailTriGroup[dt] = g;
    }
  }
  const globalDiag = diagonalOf(bSurf.position, dSurf.position);
  const corrRes = bakeCorrespondRust({
    width,
    height,
    samplesPerAxis,
    basePos: Float64Array.from(bSurf.position),
    baseNorm: Float64Array.from(bSurf.normal),
    baseTan: bSurf.tangent,
    baseUv: bSurf.uv,
    baseIdx: bSurf.indices,
    baseTriGroup: triangles.group,
    baseTriIsland: atlas.islands,
    detailPos: Float64Array.from(dSurf.position),
    detailNorm: Float64Array.from(dSurf.normal),
    detailIdx: dSurf.indices,
    detailTriGroup,
    detailTriSlot: dSurf.triangleSlot,
    detailFloater: baker.floater,
    groups: groups.map((g) => ({
      offset: g.offset,
      maxRay: g.maxRay,
      diagonal: globalDiag,
      dirMode: directionCode(g.direction),
      clipCheck: params.rawCage !== true,
    })),
  });
  if (!corrRes.ok) {
    const code =
      corrRes.error.code === 'kernel-invalid-value' ? 'model-invalid-argument' : 'model-internal';
    return err(modelingError(code, corrRes.error.reason, { field: corrRes.error.field }));
  }

  const corr = corrRes.value;
  const c = corr.counters;
  const groupReports: BakeGroupReport[] = groups.map((g, gi) => ({
    id: g.id,
    offset: g.offset,
    maxRay: g.maxRay,
    samples: gi === 0 ? c.rayHits + c.nearest : 0,
    rayHits: gi === 0 ? c.rayHits : 0,
    nearest: gi === 0 ? c.nearest : 0,
    clipped: gi === 0 ? c.clipped : 0,
    steepArea: g.steep,
    detailTriangles: g.triangles,
    aoDistance: g.aoDistance,
    thicknessDistance: g.thicknessDistance,
    stray: {
      parts: g.strayParts,
      gap: g.strayGap,
      samples: 0,
      clusters: [],
    },
    clipClusters: [],
    missClusters: [],
    branches: {
      cage: gi === 0 ? c.primary : 0,
      base: gi === 0 ? c.rescued : 0,
      extended: gi === 0 ? c.extended : 0,
      flat: gi === 0 ? c.missed : 0,
    },
  }));
  const handedness = { samples: 0, face: -1 };
  const provenance: BakeProvenance = {
    covered: c.coveredTexels,
    rayHits: c.rayHits,
    nearest: c.nearest,
    groups: groupReports,
    materials: prepared.detailSlots.map((name) => ({
      slot: name,
      color: resolveSlot(params.slots, name, emissiveScale(params.slots)).baseColor.slice(0, 3),
    })),
    curvatureRange: 1,
    heightRange: encoding.heightRange,
    positionBounds: encoding.positionBounds,
    emissiveScale: emissiveScale(params.slots),
    bleed: [],
    stack: { samples: 0, conflicts: 0, maxAngle: 0, maxHeight: 0, face: -1 },
    handedness,
  };
  const metrics = {
    covered: c.coveredTexels,
    coverage: c.coveredTexels / (width * height),
    rayHits: c.rayHits,
    nearest: c.nearest,
  };
  return ok({ corr, prepared, provenance, metrics });
}

/**
 * Evaluate maps from an active `RustBakeCorrespondence` handle using `mk_bake_correspond_eval`.
 * Copies RGBA Float32 buffers out and disposes all `RustImageBuffer` arena handles immediately.
 */
export function evaluateBakeMapsWithRustKernel(
  state: RustBakeCorrespondenceState,
  evalParams: BakeJobParams,
): Result<BackendOutput<'bake'>, ModelingError> {
  const { corr, prepared, provenance, metrics } = state;
  const maps: RustBakeMapKindName[] = [];
  for (const kind of evalParams.maps) {
    if (!isRustBakeMapKind(kind)) {
      return err(
        modelingError(
          'model-invalid-argument',
          `map '${kind}' is not supported by Rust bake evaluator`,
          { map: kind },
        ),
      );
    }
    maps.push(kind);
  }

  const scale = emissiveScale(evalParams.slots);
  const resolvedSlots = prepared.detailSlots.map((name) => {
    const s = resolveSlot(evalParams.slots, name, scale);
    return {
      baseColor: [
        s.baseColor[0] ?? 1,
        s.baseColor[1] ?? 1,
        s.baseColor[2] ?? 1,
        s.baseColor[3] ?? 1,
      ] as const,
      roughness: s.roughness,
      metallic: s.metallic,
      emissive: [s.emissive[0] ?? 0, s.emissive[1] ?? 0, s.emissive[2] ?? 0] as const,
    };
  });

  const { w, h } = gridOf(evalParams);
  const gutter = evalParams.gutter === 'fill' ? Math.max(w, h) : evalParams.gutter;
  const aoDistance =
    typeof evalParams.ao.distance === 'number' ? evalParams.ao.distance : undefined;
  const evalRes = corr.evaluate({
    maps,
    slots: resolvedSlots,
    gutter,
    aoSamples: evalParams.ao.rays,
    aoCone: cos((evalParams.ao.bias / 180) * Math.PI),
    ...(aoDistance === undefined ? {} : { aoDistance }),
    aoBias: 1e-4,
  });
  if (!evalRes.ok) {
    return err(
      modelingError('model-internal', evalRes.error.reason, { field: evalRes.error.field }),
    );
  }

  const outputs: Uint8Array[] = [];
  try {
    for (const kind of maps) {
      const img = evalRes.value.images[kind];
      if (img === undefined) {
        return err(
          modelingError('model-internal', `Rust bake returned missing buffer for ${kind}`),
        );
      }
      const view = img.dataView();
      if (!view.ok) {
        return err(modelingError('model-internal', view.error.reason, { field: view.error.field }));
      }
      const f32 = view.value;
      outputs.push(
        new Uint8Array(f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength)),
      );
    }
  } finally {
    for (const img of Object.values(evalRes.value.images)) img.dispose();
  }

  return ok({
    status: 'ok',
    outputs,
    provenance: {
      ...provenance,
      curvatureRange: evalRes.value.curvatureRange,
      heightRange: evalRes.value.heightRange,
      positionBounds: {
        min: evalRes.value.positionBounds.min as Tuple3,
        max: evalRes.value.positionBounds.max as Tuple3,
      },
      emissiveScale: scale,
    },
    locations: [],
    metrics,
  });
}

export {
  type BakeMapKind,
  bakeCorrespondRust,
  type RustBakeCorrespondence,
  type RustBakeMapKindName,
  resolveBakeCageRust,
};
