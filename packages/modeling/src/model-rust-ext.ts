import { err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import {
  packPreserveConstraints,
  rustExtApplyDraft,
  rustExtArap,
  rustExtBridge,
  rustExtCleanupPlanar,
  rustExtCleanupQuads,
  rustExtCleanupSlivers,
  rustExtCleanupTiling,
  rustExtCone,
  rustExtCurveDeform,
  rustExtDeformBend,
  rustExtDeformTwist,
  rustExtDisconnect,
  rustExtDissolve,
  rustExtDuplicate,
  rustExtExtrudePolygon,
  rustExtHausdorff,
  rustExtHole,
  rustExtImplicitSmooth,
  rustExtLattice,
  rustExtLift,
  rustExtLoft,
  rustExtLoopCut,
  rustExtLowpoly,
  rustExtMarkCrease,
  rustExtMarkFloat,
  rustExtMarkPartRole,
  rustExtOrient,
  rustExtPipeNetwork,
  rustExtPlaneCut,
  rustExtPolygon,
  rustExtQuality,
  rustExtRemesh,
  rustExtResolveTJunctions,
  rustExtShell,
  rustExtShrinkwrap,
  rustExtSimplify,
  rustExtSkinBind,
  rustExtSmooth,
  rustExtSpherize,
  rustExtSplitEdges,
  rustExtTriangulate,
  rustExtUvLightmap,
  rustExtUvOverlaps,
  rustExtUvPlanSeams,
  rustExtUvStraighten,
  rustExtUvSwatch,
  rustExtUvTrim,
  rustExtVoxelRemesh,
} from '@forgeax/modeling-kernel';
import type { CutPlane, PlaneCutOptions } from './cut';
import type {
  BendOptions,
  CurveDeformOptions,
  LatticeOptions,
  SmoothOptions,
  TwistOptions,
} from './deform';
import type { ArapOptions, ImplicitSmoothOptions } from './deform-solve';
import type { ApplyDraftOptions } from './draft';
import { type ModelingError, modelingError } from './errors';
import { type Axis, normalize, type SignedAxis, type Tuple3 } from './geom';
import type { LowpolyOptions } from './lowpoly';
import type { CornerChannelName, EditMesh } from './mesh';
import { kernelErrorToModelingError, type RustEditMeshStore } from './mesh-store-rust';
import { resolveRustFaces, resolveRustMipPadding } from './model-rust';
import type { Attribution, RoleCounts } from './ops';
import type { PipeNetworkOptions } from './pipe-network';
import type { ConeOptions, ExtrudePolygonOptions, Point2, PolygonOptions } from './primitives';
import type { RemeshOptions, SimplifyOptions, TilingOptions } from './remesh';
import type { PlanSeamsOptions } from './seams';
import type { EdgeSelector, FaceSelector, VertSelector } from './selectors';
import type { ShrinkwrapOptions } from './shrinkwrap';
import type { SpherizeOptions } from './spherize';
import type { LoftOptions } from './sweep';
import type { StraightenOptions, SwatchUvOptions, TrimUvOptions } from './uv';
import type { LightmapOptions } from './uv-channel';

const ALIVE = 0x80000000;

const SIGNED_AXIS_ID: Record<SignedAxis, number> = {
  '+x': 0,
  '-x': 1,
  '+y': 2,
  '-y': 3,
  '+z': 4,
  '-z': 5,
};

function axisId(axis: Axis): number {
  return axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
}

function internRoles(store: RustEditMeshStore, attribution: Attribution, roles: readonly string[]) {
  if (attribution.label === 0) return;
  for (const role of roles) store.internRole(role);
}

export function resolveRustTargetVertices(
  store: RustEditMeshStore,
  target: FaceSelector | VertSelector | undefined,
): Result<number[], ModelingError> {
  const v = store.views();
  if (target === undefined) {
    const out: number[] = [];
    for (let i = 0; i < v.vertexHighWater; i++) {
      if (((v.vGen[i] ?? 0) & ALIVE) !== 0) out.push(i);
    }
    return ok(out);
  }
  if (target.domain === 'vert') {
    return store.resolveSelector(target as VertSelector);
  }
  const fRes = store.resolveSelector(target as FaceSelector);
  if (!fRes.ok) return fRes;
  const seen = new Set<number>();
  for (const f of fRes.value) {
    const start = v.fHalf[f] ?? -1;
    let h = start;
    if (h < 0) continue;
    do {
      seen.add(v.hVert[h] ?? 0);
      h = v.hNext[h] ?? -1;
    } while (h >= 0 && h !== start);
  }
  return ok([...seen].sort((a, b) => a - b));
}

export function triangulateRustStoreFaces(
  store: RustEditMeshStore,
  faceIds?: readonly number[],
): { readonly positions: Float64Array; readonly indices: Uint32Array } {
  const v = store.views();
  const posList: number[] = [];
  const idxList: number[] = [];
  const vMap = new Map<number, number>();
  const addVert = (vi: number): number => {
    const prev = vMap.get(vi);
    if (prev !== undefined) return prev;
    const next = posList.length / 3;
    posList.push(v.pos[vi * 3] ?? 0, v.pos[vi * 3 + 1] ?? 0, v.pos[vi * 3 + 2] ?? 0);
    vMap.set(vi, next);
    return next;
  };
  const visitFace = (f: number) => {
    const start = v.fHalf[f] ?? -1;
    if (start < 0) return;
    const loop: number[] = [];
    let h = start;
    do {
      loop.push(addVert(v.hVert[h] ?? 0));
      h = v.hNext[h] ?? -1;
    } while (h >= 0 && h !== start);
    const base = loop[0] ?? 0;
    for (let i = 1; i + 1 < loop.length; i++) {
      idxList.push(base, loop[i] ?? 0, loop[i + 1] ?? 0);
    }
  };
  if (faceIds !== undefined) {
    for (const f of faceIds) visitFace(f);
  } else {
    for (let f = 0; f < v.faceHighWater; f++) {
      if (((v.fGen[f] ?? 0) & ALIVE) !== 0) visitFace(f);
    }
  }
  return { positions: Float64Array.from(posList), indices: Uint32Array.from(idxList) };
}

export function triangulateEditMeshFaces(mesh: EditMesh): {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
} {
  const posList: number[] = [];
  const idxList: number[] = [];
  const vMap = new Map<number, number>();
  for (const f of mesh.faces()) {
    const verts = mesh.faceVertices(f);
    const loop = verts.map((vi) => {
      const prev = vMap.get(vi);
      if (prev !== undefined) return prev;
      const next = posList.length / 3;
      const p = mesh.position(vi);
      posList.push(p[0], p[1], p[2]);
      vMap.set(vi, next);
      return next;
    });
    const base = loop[0] ?? 0;
    for (let i = 1; i + 1 < loop.length; i++) {
      idxList.push(base, loop[i] ?? 0, loop[i + 1] ?? 0);
    }
  }
  return { positions: Float64Array.from(posList), indices: Uint32Array.from(idxList) };
}

export function rustWeld(
  store: RustEditMeshStore,
  distance: number,
): Result<RoleCounts, ModelingError> {
  const res = store.rustMesh.weld(distance);
  if (!res.ok) return err(kernelErrorToModelingError(res.error));
  return ok({ merged: res.value.merged, collapsed: res.value.collapsed });
}

export function rustMarkRole(
  store: RustEditMeshStore,
  faces: FaceSelector,
  role: 'form' | 'detail' | 'tool',
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  const res = rustExtMarkPartRole(store.rustMesh, ids.value, role);
  return res.ok ? ok({ [role]: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustMarkFloat(
  store: RustEditMeshStore,
  faces: FaceSelector,
  floating: boolean,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  const res = rustExtMarkFloat(store.rustMesh, ids.value, floating);
  return res.ok
    ? ok({ [floating ? 'float' : 'unfloat']: res.value })
    : err(kernelErrorToModelingError(res.error));
}

export function rustMarkCrease(
  store: RustEditMeshStore,
  edges: EdgeSelector,
  sharpness: number,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(edges);
  if (!ids.ok) return ids;
  const res = rustExtMarkCrease(store.rustMesh, ids.value, sharpness);
  return res.ok ? ok({ edges: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustOrient(
  store: RustEditMeshStore,
  faces: FaceSelector,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  const res = rustExtOrient(store.rustMesh, ids.value);
  return res.ok ? ok({ flipped: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustTriangulate(
  store: RustEditMeshStore,
  faces: FaceSelector,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  const res = rustExtTriangulate(store.rustMesh, ids.value);
  return res.ok ? ok({ triangles: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustDissolve(
  store: RustEditMeshStore,
  edges: EdgeSelector,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(edges);
  if (!ids.ok) return ids;
  const res = rustExtDissolve(store.rustMesh, ids.value);
  return res.ok
    ? ok({ dissolvedEdges: res.value.dissolved, merged: res.value.merged })
    : err(kernelErrorToModelingError(res.error));
}

export function rustSplit(
  store: RustEditMeshStore,
  edges: EdgeSelector,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(edges);
  if (!ids.ok) return ids;
  const res = rustExtSplitEdges(store.rustMesh, ids.value);
  return res.ok ? ok({ splitVertices: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustCleanupPlanar(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
  tolerance: number,
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  const res = rustExtCleanupPlanar(store.rustMesh, ids.value, tolerance);
  if (!res.ok) return err(kernelErrorToModelingError(res.error));
  if (res.value.mergedGroups === 0 && res.value.removedVertices === 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        'cleanup.planar merges coplanar faces or removes a collinear vertex',
        { faces: ids.value.length },
      ),
    );
  }
  return ok(res.value);
}

export function rustCleanupQuads(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
  options: { readonly maxAngle?: number; readonly maxPlanarity?: number },
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  const res = rustExtCleanupQuads(
    store.rustMesh,
    ids.value,
    options.maxAngle ?? 15,
    options.maxPlanarity ?? 0.02,
  );
  if (!res.ok) return err(kernelErrorToModelingError(res.error));
  if (res.value === 0) {
    return err(
      modelingError('model-op-no-effect', 'cleanup.quads pairs at least two triangles', {
        faces: ids.value.length,
      }),
    );
  }
  return ok({ quads: res.value });
}

export function rustCleanupSlivers(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
  width: number,
  quiet: boolean,
  tolerance: number,
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  const res = rustExtCleanupSlivers(store.rustMesh, ids.value, width, tolerance);
  if (!res.ok) return err(kernelErrorToModelingError(res.error));
  if (res.value.removed === 0 && res.value.kept === 0 && !quiet) {
    return err(
      modelingError('model-op-no-effect', `cleanup.slivers finds a face narrower than ${width} m`, {
        width,
        faces: ids.value.length,
      }),
    );
  }
  return ok({ removed: res.value.removed, kept: res.value.kept });
}

export function rustResolveTJunctions(
  store: RustEditMeshStore,
  distance: number,
): Result<RoleCounts, ModelingError> {
  const res = rustExtResolveTJunctions(store.rustMesh, distance);
  return res.ok ? ok({ inserted: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustSimplify(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
  options: SimplifyOptions,
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  const res = rustExtSimplify(store.rustMesh, ids.value, {
    ...(options.targetFaces === undefined ? {} : { targetFaces: options.targetFaces }),
    ...(options.maxError === undefined ? {} : { maxError: options.maxError }),
    constraintBits: packPreserveConstraints(options.preserve),
  });
  return res.ok
    ? ok({ triangles: res.value.triangles })
    : err(kernelErrorToModelingError(res.error));
}

export function rustRemesh(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
  options: RemeshOptions,
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  const res = rustExtRemesh(store.rustMesh, ids.value, {
    targetEdgeLength: options.targetEdgeLength,
    iterations: options.iterations,
    ...(options.smoothing === undefined ? {} : { smoothWeight: options.smoothing }),
    constraintBits: packPreserveConstraints(options.preserve),
  });
  return res.ok ? ok({ triangles: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustCleanupTiling(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
  options: TilingOptions,
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  const res = rustExtCleanupTiling(
    store.rustMesh,
    ids.value,
    options.maxAspect ?? 5,
    options.maxError,
    options.iterations ?? 10,
  );
  return res.ok ? ok({ triangles: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustLowpoly(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
  options: LowpolyOptions,
  tolerance: number,
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  const uvPad = options.uv?.padding !== undefined ? resolveRustMipPadding(options.uv.padding) : 4;
  if (options.tags?.groupPrefix !== undefined) {
    // Intern likely component group prefix tags
    store.internTag(`${options.tags.groupPrefix}0`, true);
  }
  const res = rustExtLowpoly(store.rustMesh, ids.value, {
    targetFaces: options.targetFaces,
    hardAngle: options.hardAngle ?? 40,
    rolesFormOnly: options.roles === 'form',
    autoUv: options.uv !== undefined,
    ...(options.uv?.resolution === undefined ? {} : { uvResolution: options.uv.resolution }),
    uvPadding: Number.isFinite(uvPad) ? uvPad : 4,
    preserveGroups: options.tags?.preserveGroups !== false,
    ...(options.tags?.groupPrefix === undefined ? {} : { groupPrefix: options.tags.groupPrefix }),
    tolerance,
  });
  return res.ok
    ? ok({ triangles: res.value.triangles, quads: res.value.quads })
    : err(kernelErrorToModelingError(res.error));
}

export function rustVoxelRemesh(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
  mode: 'fill' | 'offset',
  options: { readonly voxelSize: number; readonly distance?: number; readonly band?: number },
  attribution: Attribution,
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  internRoles(store, attribution, ['surface']);
  const res = rustExtVoxelRemesh(store.rustMesh, ids.value, {
    mode,
    voxelSize: options.voxelSize,
    ...(options.distance === undefined ? {} : { distance: options.distance }),
    ...(options.band === undefined ? {} : { band: options.band }),
    label: attribution.label,
    material: attribution.material,
    tag: attribution.tag,
  });
  return res.ok ? ok({ surface: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustDuplicate(
  store: RustEditMeshStore,
  faces: FaceSelector,
  attribution: Attribution,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  internRoles(store, attribution, ['copy']);
  const res = rustExtDuplicate(store.rustMesh, ids.value, attribution);
  return res.ok ? ok({ copy: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustDisconnect(
  store: RustEditMeshStore,
  faces: FaceSelector,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  const res = rustExtDisconnect(store.rustMesh, ids.value);
  return res.ok ? ok({ disconnected: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustBridge(
  store: RustEditMeshStore,
  edges: EdgeSelector,
  attribution: Attribution,
  options: { readonly segments?: number; readonly material?: string },
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(edges);
  if (!ids.ok) return ids;
  internRoles(store, attribution, ['bridge']);
  const res = rustExtBridge(store.rustMesh, ids.value, options.segments ?? 1, {
    label: attribution.label,
    material: options.material === undefined ? -1 : attribution.material,
    tag: attribution.tag,
  });
  return res.ok ? ok({ bridge: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustLoopCut(
  store: RustEditMeshStore,
  edges: EdgeSelector,
  cuts: number,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(edges);
  if (!ids.ok) return ids;
  const res = rustExtLoopCut(store.rustMesh, ids.value, cuts);
  return res.ok ? ok({ cuts: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustPlaneCut(
  store: RustEditMeshStore,
  attribution: Attribution,
  plane: CutPlane | (PlaneCutOptions & { readonly material?: string }),
  positiveOnly: boolean,
  tolerance: number,
): Result<RoleCounts, ModelingError> {
  const keepNeg = 'keep' in plane && plane.keep === 'negative';
  const normal: Tuple3 = keepNeg
    ? [-plane.normal[0], -plane.normal[1], -plane.normal[2]]
    : plane.normal;
  const fillHolesCap = 'fillHoles' in plane ? (plane.fillHoles ?? false) : false;
  if (fillHolesCap) internRoles(store, attribution, ['cap']);
  const res = rustExtPlaneCut(store.rustMesh, plane.point, normal, {
    positiveOnly,
    fillHolesCap,
    tolerance,
    label: attribution.label,
    material: 'material' in plane && plane.material !== undefined ? attribution.material : -1,
    tag: attribution.tag,
  });
  return res.ok ? ok({ faces: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustShell(
  store: RustEditMeshStore,
  attribution: Attribution,
  faces: FaceSelector,
  thickness: number,
  direction: 'in' | 'out' | 'both' = 'in',
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  internRoles(store, attribution, ['inner', 'rim']);
  const res = rustExtShell(store.rustMesh, ids.value, thickness, direction, attribution);
  return res.ok ? ok({ shellFaces: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustHole(
  store: RustEditMeshStore,
  attribution: Attribution,
  faces: FaceSelector,
  options: {
    readonly diameter: number;
    readonly depth: number;
    readonly centers: readonly Point2[];
    readonly segments?: number;
    readonly material?: string;
  },
  tolerance: number,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  const faceId = ids.value[0];
  if (faceId === undefined || ids.value.length !== 1) {
    return err(
      modelingError('model-selection-cardinality', 'hole targets one planar face', {
        faces: ids.value.length,
      }),
    );
  }
  internRoles(store, attribution, ['wall', 'bottom']);
  const res = rustExtHole(
    store.rustMesh,
    faceId,
    options.centers,
    options.diameter,
    options.depth,
    options.segments ?? 24,
    {
      label: attribution.label,
      material: options.material === undefined ? -1 : attribution.material,
      tag: attribution.tag,
    },
    tolerance,
  );
  return res.ok ? ok({ holeFaces: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustPolygon(
  store: RustEditMeshStore,
  attribution: Attribution,
  options: PolygonOptions,
): Result<RoleCounts, ModelingError> {
  internRoles(store, attribution, ['face']);
  const pts2d = options.points.map((p) => [p[0], p[1]] as const);
  const res = rustExtPolygon(store.rustMesh, pts2d, false, attribution);
  return res.ok ? ok({ face: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustCone(
  store: RustEditMeshStore,
  attribution: Attribution,
  options: ConeOptions & { readonly radialSegments: number },
): Result<RoleCounts, ModelingError> {
  internRoles(store, attribution, ['side', 'bottom']);
  const res = rustExtCone(
    store.rustMesh,
    options.radius,
    options.height,
    options.radialSegments,
    options.openEnded ?? false,
    options.center ?? [0, 0, 0],
    attribution,
  );
  return res.ok ? ok({ faces: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustExtrudePolygon(
  store: RustEditMeshStore,
  attribution: Attribution,
  options: ExtrudePolygonOptions,
): Result<RoleCounts, ModelingError> {
  internRoles(store, attribution, ['top', 'bottom', 'side']);
  const res = rustExtExtrudePolygon(store.rustMesh, options.points, options.depth, attribution);
  return res.ok ? ok({ faces: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustLoft(
  store: RustEditMeshStore,
  attribution: Attribution,
  options: LoftOptions,
): Result<RoleCounts, ModelingError> {
  internRoles(store, attribution, ['side', 'start', 'end']);
  const res = rustExtLoft(store.rustMesh, options.profiles, options.caps !== false, attribution);
  return res.ok ? ok({ faces: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustPipeNetwork(
  store: RustEditMeshStore,
  attribution: Attribution,
  options: PipeNetworkOptions,
): Result<RoleCounts, ModelingError> {
  internRoles(store, attribution, ['node', 'strut', 'cap']);
  const res = rustExtPipeNetwork(
    store.rustMesh,
    options.nodes,
    options.edges,
    options.radius,
    options.ringSegments ?? 8,
    attribution,
  );
  return res.ok ? ok({ faces: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustLift(
  store: RustEditMeshStore,
  attribution: Attribution,
  source: MeshAsset,
): Result<RoleCounts, ModelingError> {
  const pos = source.attributes.position;
  if (!(pos instanceof Float32Array) || pos.length % 3 !== 0) {
    return err(modelingError('model-precondition', 'the mesh carries float32 xyz positions', {}));
  }
  const rawIdx = source.indices;
  const idx =
    rawIdx instanceof Uint32Array
      ? rawIdx
      : rawIdx instanceof Uint16Array
        ? Uint32Array.from(rawIdx)
        : undefined;
  if (idx === undefined) {
    return err(modelingError('model-precondition', 'the mesh carries triangle indices', {}));
  }
  const uvs = source.attributes.uv instanceof Float32Array ? source.attributes.uv : undefined;
  const res = rustExtLift(store.rustMesh, pos, idx, uvs, 40, attribution);
  return res.ok ? ok({ faces: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustBend(
  store: RustEditMeshStore,
  target: FaceSelector | VertSelector,
  options: BendOptions,
): Result<RoleCounts, ModelingError> {
  const verts = resolveRustTargetVertices(store, target);
  if (!verts.ok) return verts;
  const res = rustExtDeformBend(
    store.rustMesh,
    verts.value,
    axisId(options.axis),
    SIGNED_AXIS_ID[options.toward],
    options.angle,
    options.range,
    options.origin,
  );
  return res.ok ? ok({ vertices: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustTwist(
  store: RustEditMeshStore,
  target: FaceSelector | VertSelector,
  options: TwistOptions,
): Result<RoleCounts, ModelingError> {
  const verts = resolveRustTargetVertices(store, target);
  if (!verts.ok) return verts;
  const res = rustExtDeformTwist(
    store.rustMesh,
    verts.value,
    axisId(options.axis),
    options.angle,
    options.range,
    options.origin,
  );
  return res.ok ? ok({ vertices: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustLattice(
  store: RustEditMeshStore,
  target: FaceSelector | VertSelector,
  options: LatticeOptions,
): Result<RoleCounts, ModelingError> {
  const verts = resolveRustTargetVertices(store, target);
  if (!verts.ok) return verts;
  const res = rustExtLattice(store.rustMesh, verts.value, options.resolution, options.offsets);
  return res.ok ? ok({ vertices: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustApplyDraft(
  store: RustEditMeshStore,
  faces: FaceSelector,
  options: ApplyDraftOptions,
): Result<RoleCounts, ModelingError> {
  const fRes = store.resolveSelector(faces);
  if (!fRes.ok) return fRes;
  const nRes = store.resolveSelector(options.neutral);
  if (!nRes.ok) return nRes;
  if (nRes.value.length === 0) {
    return err(modelingError('model-selection-empty', 'neutral faces are non-empty', {}));
  }
  const v = store.views();
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let cnt = 0;
  for (const nf of nRes.value) {
    const start = v.fHalf[nf] ?? -1;
    let h = start;
    if (h < 0) continue;
    do {
      const vi = v.hVert[h] ?? 0;
      sx += v.pos[vi * 3] ?? 0;
      sy += v.pos[vi * 3 + 1] ?? 0;
      sz += v.pos[vi * 3 + 2] ?? 0;
      cnt++;
      h = v.hNext[h] ?? -1;
    } while (h >= 0 && h !== start);
  }
  const pt: Tuple3 = cnt > 0 ? [sx / cnt, sy / cnt, sz / cnt] : [0, 0, 0];
  const dir = normalize(options.direction);
  const res = rustExtApplyDraft(store.rustMesh, fRes.value, pt, dir, options.angle);
  return res.ok ? ok({ vertices: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustSpherize(
  store: RustEditMeshStore,
  target: FaceSelector | VertSelector,
  options: SpherizeOptions,
): Result<RoleCounts, ModelingError> {
  const verts = resolveRustTargetVertices(store, target);
  if (!verts.ok) return verts;
  const radius = options.radii !== undefined ? options.radii[0] : -1;
  const res = rustExtSpherize(store.rustMesh, verts.value, options.factor, radius, options.center);
  return res.ok ? ok({ vertices: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustCurveDeform(
  store: RustEditMeshStore,
  target: FaceSelector | VertSelector,
  options: CurveDeformOptions,
  path: readonly Tuple3[],
): Result<RoleCounts, ModelingError> {
  const verts = resolveRustTargetVertices(store, target);
  if (!verts.ok) return verts;
  const res = rustExtCurveDeform(
    store.rustMesh,
    verts.value,
    path,
    axisId(options.axis),
    options.origin,
  );
  return res.ok ? ok({ vertices: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustSmooth(
  store: RustEditMeshStore,
  target: FaceSelector | VertSelector,
  options: SmoothOptions,
): Result<RoleCounts, ModelingError> {
  const verts = resolveRustTargetVertices(store, target);
  if (!verts.ok) return verts;
  const res = rustExtSmooth(
    store.rustMesh,
    verts.value,
    options.lambda ?? 0.5,
    options.mu ?? -0.53,
    options.iterations,
    options.pin?.boundary !== false,
    options.pin?.sharp !== false,
  );
  return res.ok ? ok({ vertices: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustImplicitSmooth(
  store: RustEditMeshStore,
  target: FaceSelector | VertSelector | undefined,
  options: ImplicitSmoothOptions,
): Result<RoleCounts, ModelingError> {
  const verts = resolveRustTargetVertices(store, target);
  if (!verts.ok) return verts;
  const pinRules =
    options.pin === undefined
      ? (['boundary', 'sharp'] as const)
      : Array.isArray(options.pin)
        ? options.pin
        : [options.pin];
  let pinBoundary = false;
  let pinSharp = false;
  const extraPins: number[] = [];
  for (const r of pinRules) {
    if (r === 'boundary') pinBoundary = true;
    else if (r === 'sharp') pinSharp = true;
    else {
      const pv = resolveRustTargetVertices(store, r as FaceSelector | VertSelector);
      if (!pv.ok) return pv;
      for (const id of pv.value) extraPins.push(id);
    }
  }
  const res = rustExtImplicitSmooth(
    store.rustMesh,
    verts.value,
    options.lambda,
    options.iterations ?? 1,
    extraPins,
    pinBoundary,
    pinSharp,
    options.preserveVolume === true,
  );
  return res.ok ? ok({ vertices: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustArap(
  store: RustEditMeshStore,
  target: FaceSelector | VertSelector,
  options: ArapOptions,
): Result<RoleCounts, ModelingError> {
  const verts = resolveRustTargetVertices(store, target);
  if (!verts.ok) return verts;
  const v = store.views();
  const constraints: { vertex: number; position: Tuple3 }[] = [];
  const constrained = new Set<number>();

  for (const h of options.handles) {
    const hv = resolveRustTargetVertices(store, h.selector as FaceSelector | VertSelector);
    if (!hv.ok) return hv;
    let dx = 0;
    let dy = 0;
    let dz = 0;
    if (h.translate !== undefined) {
      [dx, dy, dz] = h.translate;
    } else if (h.to !== undefined && hv.value.length > 0) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const id of hv.value) {
        cx += v.pos[id * 3] ?? 0;
        cy += v.pos[id * 3 + 1] ?? 0;
        cz += v.pos[id * 3 + 2] ?? 0;
      }
      const n = hv.value.length;
      dx = h.to[0] - cx / n;
      dy = h.to[1] - cy / n;
      dz = h.to[2] - cz / n;
    }
    for (const id of hv.value) {
      if (constrained.has(id)) continue;
      constrained.add(id);
      constraints.push({
        vertex: id,
        position: [
          (v.pos[id * 3] ?? 0) + dx,
          (v.pos[id * 3 + 1] ?? 0) + dy,
          (v.pos[id * 3 + 2] ?? 0) + dz,
        ],
      });
    }
  }

  const pinRules =
    options.pin === undefined ? [] : Array.isArray(options.pin) ? options.pin : [options.pin];
  for (const r of pinRules) {
    if (typeof r !== 'string') {
      const pv = resolveRustTargetVertices(store, r as FaceSelector | VertSelector);
      if (!pv.ok) return pv;
      for (const id of pv.value) {
        if (constrained.has(id)) continue;
        constrained.add(id);
        constraints.push({
          vertex: id,
          position: [v.pos[id * 3] ?? 0, v.pos[id * 3 + 1] ?? 0, v.pos[id * 3 + 2] ?? 0],
        });
      }
    }
  }

  const res = rustExtArap(store.rustMesh, verts.value, constraints, options.iterations ?? 10);
  return res.ok ? ok({ vertices: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustShrinkwrap(
  store: RustEditMeshStore,
  target: FaceSelector | VertSelector,
  targetSurface: { readonly positions: Float64Array; readonly indices: Uint32Array },
  options: ShrinkwrapOptions,
): Result<RoleCounts, ModelingError> {
  const verts = resolveRustTargetVertices(store, target);
  if (!verts.ok) return verts;
  const dir =
    options.mode === 'project' && Array.isArray(options.direction)
      ? (options.direction as Tuple3)
      : undefined;
  const res = rustExtShrinkwrap(
    store.rustMesh,
    verts.value,
    targetSurface.positions,
    targetSurface.indices,
    {
      ...(dir === undefined ? {} : { direction: dir }),
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      ...(options.maxDistance === undefined ? {} : { maxDistance: options.maxDistance }),
    },
  );
  return res.ok ? ok({ vertices: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustUvPlan(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
  options: PlanSeamsOptions,
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  const respectSharp =
    typeof options.respectSharp === 'boolean'
      ? options.respectSharp
      : options.respectSharp !== undefined;
  const res = rustExtUvPlanSeams(store.rustMesh, ids.value, options.hardAngle ?? 75, respectSharp);
  return res.ok ? ok({ seams: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustUvStraighten(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
  options: StraightenOptions,
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  const res = rustExtUvStraighten(
    store.rustMesh,
    ids.value,
    options.channel ?? 'uv0',
    options.maxAngle ?? 20,
  );
  return res.ok ? ok({ straightened: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustUvLightmap(
  store: RustEditMeshStore,
  options: LightmapOptions,
): Result<RoleCounts, ModelingError> {
  const pad = options.padding === undefined ? 4 : resolveRustMipPadding(options.padding);
  if (!Number.isFinite(pad) || pad < 0) {
    return err(modelingError('model-invalid-argument', 'lightmap padding is non-negative', {}));
  }
  const res = rustExtUvLightmap(store.rustMesh, options.resolution, pad, 'uv1');
  return res.ok ? ok({ packed: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustUvTrim(
  store: RustEditMeshStore,
  faces: FaceSelector,
  options: TrimUvOptions,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  const region = Array.isArray(options.region) ? options.region[0] : options.region;
  if (region === undefined) {
    return err(modelingError('model-invalid-argument', 'trim region is required', {}));
  }
  const tileU = (options.fit?.u ?? (region.tiling === 'u' ? 'tile' : 'metric')) === 'tile';
  const [u0, v0, u1, v1] = region.uv;
  const res = rustExtUvTrim(
    store.rustMesh,
    ids.value,
    [u0, u1],
    [v0, v1],
    tileU,
    options.channel ?? 'uv0',
  );
  return res.ok ? ok({ faces: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustUvSwatch(
  store: RustEditMeshStore,
  faces: FaceSelector,
  options: SwatchUvOptions,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  const [u0, v0, u1, v1] = options.region.uv;
  const res = rustExtUvSwatch(
    store.rustMesh,
    ids.value,
    [u0, u1],
    [v0, v1],
    options.channel ?? 'uv0',
  );
  return res.ok ? ok({ faces: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustMeshQualityCheck(store: RustEditMeshStore, faces: FaceSelector | undefined) {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  return rustExtQuality(store.rustMesh, ids.value);
}

export function rustUvOverlapPairs(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
  channel: CornerChannelName = 'uv0',
) {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  return rustExtUvOverlaps(store.rustMesh, ids.value, channel);
}

export { rustExtHausdorff, rustExtSkinBind };
