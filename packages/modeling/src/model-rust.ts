import { err, ok, type Result } from '@forgeax/engine-types';
import type { ArrayOptions } from './array';
import type { BooleanOperation } from './compute/job';
import type { TaperOptions } from './deform';
import { type ModelingError, modelingError } from './errors';
import { type Axis, axisVector, type Tuple3 } from './geom';
import type { EDGE_SEAM, EDGE_SHARP, EditMesh } from './mesh';
import {
  kernelErrorToModelingError,
  type RustEditMeshStore,
  syncTsToRust,
} from './mesh-store-rust';
import type { Attribution, ProjectOptions, RegionMode, RoleCounts } from './ops';
import type { PanelLineOptions } from './panel';
import type {
  BoxOptions,
  CylinderOptions,
  PlaneOptions,
  RevolveOptions,
  SphereOptions,
  TorusOptions,
} from './primitives';
import type { EdgeSelector, FaceSelector } from './selectors';
import type { SubdivideOptions } from './subdivide';
import type { SweepOptions } from './sweep';
import type { AutoUvOptions, PackOptions, UnwrapOptions } from './uv';

export interface RustPeerMesh {
  readonly authority: 'ts' | 'rust';
  readonly rustStore: RustEditMeshStore | undefined;
  readonly poisoned: ModelingError | undefined;
  readonly mesh: EditMesh;
}

/** Resolve active face ids from either an explicit AST selector or all live faces in `store`. */
export function resolveRustFaces(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
): Result<number[], ModelingError> {
  if (faces !== undefined) return store.resolveSelector(faces);
  const v = store.views();
  const ids: number[] = [];
  for (let f = 0; f < v.faceHighWater; f++) {
    if (((v.fGen[f] ?? 0) & 0x80000000) !== 0) ids.push(f);
  }
  return ok(ids);
}

/** Resolve numeric or mip-power UV padding, returning NaN when Rust fallback is required. */
export function resolveRustMipPadding(padding: number | { readonly mips: number }): number {
  if (typeof padding === 'number') return padding;
  if (Number.isInteger(padding.mips) && padding.mips >= 0 && padding.mips <= 10) {
    return 1 << (padding.mips + 1);
  }
  return Number.NaN;
}

function internRoles(store: RustEditMeshStore, attribution: Attribution, roles: readonly string[]) {
  if (attribution.label === 0) return;
  for (const role of roles) store.internRole(role);
}

function borrowPeerRustMesh(operand: {
  readonly authority: 'ts' | 'rust';
  readonly rustStore: RustEditMeshStore | undefined;
  readonly mesh: EditMesh;
}): Result<
  { readonly toolStore: RustEditMeshStore; readonly tempStore: RustEditMeshStore | undefined },
  ModelingError
> {
  if (operand.authority === 'rust' && operand.rustStore !== undefined) {
    return ok({ toolStore: operand.rustStore, tempStore: undefined });
  }
  const synced = syncTsToRust(operand.mesh);
  if (!synced.ok) return synced;
  return ok({ toolStore: synced.value, tempStore: synced.value });
}

export function rustBox(
  store: RustEditMeshStore,
  attribution: Attribution,
  options: BoxOptions,
): Result<RoleCounts, ModelingError> {
  internRoles(store, attribution, ['face']);
  const res = store.rustMesh.box({
    size: options.size,
    ...(options.segments === undefined ? {} : { segments: options.segments }),
    ...(options.center === undefined ? {} : { center: options.center }),
    label: attribution.label,
    material: attribution.material,
    tag: attribution.tag,
  });
  return res.ok ? ok({ face: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustPlane(
  store: RustEditMeshStore,
  attribution: Attribution,
  options: PlaneOptions,
): Result<RoleCounts, ModelingError> {
  internRoles(store, attribution, ['face']);
  const res = store.rustMesh.plane({
    width: options.width,
    height: options.height,
    ...(options.widthSegments === undefined ? {} : { widthSegments: options.widthSegments }),
    ...(options.heightSegments === undefined ? {} : { heightSegments: options.heightSegments }),
    ...(options.center === undefined ? {} : { center: options.center }),
    label: attribution.label,
    material: attribution.material,
    tag: attribution.tag,
  });
  return res.ok ? ok({ face: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustCylinder(
  store: RustEditMeshStore,
  attribution: Attribution,
  options: CylinderOptions & { readonly radialSegments: number },
): Result<RoleCounts, ModelingError> {
  internRoles(store, attribution, ['side', 'bottom', 'top']);
  const res = store.rustMesh.cylinder({
    radiusTop: options.radiusTop,
    radiusBottom: options.radiusBottom,
    height: options.height,
    radialSegments: options.radialSegments,
    ...(options.heightSegments === undefined ? {} : { heightSegments: options.heightSegments }),
    ...(options.openEnded === undefined ? {} : { openEnded: options.openEnded }),
    ...(options.center === undefined ? {} : { center: options.center }),
    label: attribution.label,
    material: attribution.material,
    tag: attribution.tag,
  });
  return res.ok ? ok({ side: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustSphere(
  store: RustEditMeshStore,
  attribution: Attribution,
  options: SphereOptions & { readonly widthSegments: number; readonly heightSegments: number },
): Result<RoleCounts, ModelingError> {
  internRoles(store, attribution, ['face']);
  const res = store.rustMesh.sphere({
    radius: options.radius,
    widthSegments: options.widthSegments,
    heightSegments: options.heightSegments,
    ...(options.center === undefined ? {} : { center: options.center }),
    label: attribution.label,
    material: attribution.material,
    tag: attribution.tag,
  });
  return res.ok ? ok({ face: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustTorus(
  store: RustEditMeshStore,
  attribution: Attribution,
  options: TorusOptions & { readonly radialSegments: number; readonly tubularSegments: number },
): Result<RoleCounts, ModelingError> {
  internRoles(store, attribution, ['face']);
  const res = store.rustMesh.torus({
    radius: options.radius,
    tube: options.tube,
    radialSegments: options.radialSegments,
    tubularSegments: options.tubularSegments,
    ...(options.angle === undefined ? {} : { angle: options.angle }),
    ...(options.center === undefined ? {} : { center: options.center }),
    label: attribution.label,
    material: attribution.material,
    tag: attribution.tag,
  });
  return res.ok ? ok({ face: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustRevolve(
  store: RustEditMeshStore,
  attribution: Attribution,
  options: RevolveOptions,
): Result<RoleCounts, ModelingError> {
  internRoles(store, attribution, ['side', 'bottom', 'top']);
  const res = store.rustMesh.revolve({
    points: options.points,
    segments: options.segments,
    ...(options.angle === undefined ? {} : { angle: options.angle }),
    label: attribution.label,
    material: attribution.material,
    tag: attribution.tag,
  });
  return res.ok ? ok({ side: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustSweep(
  store: RustEditMeshStore,
  attribution: Attribution,
  options: SweepOptions,
): Result<RoleCounts, ModelingError> {
  internRoles(store, attribution, ['side', 'start', 'end']);
  const res = store.rustMesh.sweepPolyline({
    profile: options.profile as readonly (readonly [number, number])[],
    path: options.path as readonly (readonly [number, number, number])[],
    ...(options.caps === undefined ? {} : { caps: options.caps }),
    ...(options.sharpAngle === undefined ? {} : { sharpAngle: options.sharpAngle }),
    ...(options.up === undefined ? {} : { up: options.up }),
    label: attribution.label,
    material: attribution.material,
    tag: attribution.tag,
  });
  return res.ok ? ok({ side: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustExtrude(
  store: RustEditMeshStore,
  attribution: Attribution,
  faces: FaceSelector,
  options: { readonly distance: number; readonly region: RegionMode },
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  internRoles(store, attribution, ['top', 'side']);
  const res = store.rustMesh.extrude(ids.value, {
    distance: options.distance,
    region: options.region,
    label: attribution.label,
  });
  return res.ok
    ? ok({ top: res.value.top, side: res.value.side })
    : err(kernelErrorToModelingError(res.error));
}

export function rustInset(
  store: RustEditMeshStore,
  attribution: Attribution,
  faces: FaceSelector,
  options: { readonly thickness: number; readonly region: RegionMode },
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  internRoles(store, attribution, ['inner', 'rim']);
  const res = store.rustMesh.inset(ids.value, {
    thickness: options.thickness,
    region: options.region,
    label: attribution.label,
  });
  return res.ok
    ? ok({ inner: res.value.inner, rim: res.value.rim })
    : err(kernelErrorToModelingError(res.error));
}

export function rustOffset(
  store: RustEditMeshStore,
  attribution: Attribution,
  faces: FaceSelector,
  options: { readonly distance: number; readonly region: RegionMode },
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  internRoles(store, attribution, ['top', 'side']);
  const res = store.rustMesh.offset(ids.value, {
    distance: options.distance,
    region: options.region,
    label: attribution.label,
  });
  return res.ok
    ? ok({ top: res.value.top, side: res.value.side })
    : err(kernelErrorToModelingError(res.error));
}

export function rustAppend(
  store: RustEditMeshStore,
  attribution: Attribution,
  isSelf: boolean,
  operand: RustPeerMesh,
  translate: Tuple3 | undefined,
): Result<RoleCounts, ModelingError> {
  if (isSelf) {
    return err(
      modelingError('model-invalid-argument', 'the operand is another session or snapshot', {}),
    );
  }
  if (operand.poisoned !== undefined) {
    return err(
      modelingError(
        'model-precondition',
        'the operand session is not poisoned',
        { cause: operand.poisoned.code },
        'fix the operand session first; its first failure is in detail.cause',
      ),
    );
  }
  const borrowed = borrowPeerRustMesh(operand);
  if (!borrowed.ok) return borrowed;
  const { toolStore: srcStore, tempStore } = borrowed.value;
  try {
    store.syncNameTablesFrom(srcStore);
    internRoles(store, attribution, ['part']);
    const res = store.rustMesh.appendMesh(srcStore.rustMesh, {
      ...(translate === undefined ? {} : { translate }),
      label: attribution.label,
      tag: attribution.tag,
    });
    return res.ok ? ok({ part: res.value }) : err(kernelErrorToModelingError(res.error));
  } finally {
    tempStore?.dispose();
  }
}

export function rustBevel(
  store: RustEditMeshStore,
  attribution: Attribution,
  edges: EdgeSelector,
  width: number,
  options: { readonly segments?: number; readonly material?: string },
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(edges);
  if (!ids.ok) return ids;
  internRoles(store, attribution, ['bevel', 'corner']);
  const res = store.rustMesh.bevel(ids.value, {
    width,
    segments: options.segments ?? 1,
    ...(options.material === undefined ? {} : { material: attribution.material }),
    label: attribution.label,
    tag: attribution.tag,
  });
  return res.ok
    ? ok({ bevel: res.value.bevel, ...(res.value.corner > 0 ? { corner: res.value.corner } : {}) })
    : err(kernelErrorToModelingError(res.error));
}

export function rustPanelLine(
  store: RustEditMeshStore,
  attribution: Attribution,
  faces: FaceSelector,
  point: Tuple3,
  normal: Tuple3,
  options: PanelLineOptions & { readonly material?: string },
  tolerance: number,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(faces);
  if (!ids.ok) return ids;
  internRoles(store, attribution, ['groove', 'lip', 'top', 'side']);
  const res = store.rustMesh.panelLinePlane(ids.value, {
    point,
    normal,
    width: options.width,
    depth: options.depth,
    ...(options.material === undefined ? {} : { material: attribution.material }),
    label: attribution.label,
    tag: attribution.tag,
    tolerance,
  });
  return res.ok ? ok({ groove: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustFillHoles(
  store: RustEditMeshStore,
  attribution: Attribution,
  edges: EdgeSelector,
  material: string | undefined,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(edges);
  if (!ids.ok) return ids;
  internRoles(store, attribution, ['cap']);
  const res = store.rustMesh.fillHoles(ids.value, {
    ...(material === undefined ? {} : { material: attribution.material }),
    label: attribution.label,
    tag: attribution.tag,
  });
  return res.ok ? ok({ cap: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustArray(
  store: RustEditMeshStore,
  attribution: Attribution,
  target: FaceSelector,
  options: ArrayOptions,
  prefix: string,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(target);
  if (!ids.ok) return ids;
  if ('linear' in options) {
    internRoles(store, attribution, ['copy']);
    const count = options.linear.count;
    if (Number.isInteger(count) && count >= 2 && count <= 10000) {
      for (let i = 0; i < count; i++) store.internTag(`${prefix}:${i}`, true);
    }
    const res = store.rustMesh.arrayFaces(ids.value, {
      kind: 'linear',
      count: options.linear.count,
      offset: options.linear.offset,
      prefix,
      label: attribution.label,
      tag: attribution.tag,
    });
    return res.ok ? ok({ copy: res.value }) : err(kernelErrorToModelingError(res.error));
  }
  if ('radial' in options) {
    internRoles(store, attribution, ['copy']);
    const count = options.radial.count;
    if (Number.isInteger(count) && count >= 2 && count <= 10000) {
      for (let i = 0; i < count; i++) store.internTag(`${prefix}:${i}`, true);
    }
    const res = store.rustMesh.arrayFaces(ids.value, {
      kind: 'radial',
      count: options.radial.count,
      axis:
        typeof options.radial.axis === 'string'
          ? axisVector(options.radial.axis)
          : options.radial.axis,
      ...(options.radial.angle === undefined ? {} : { angle: options.radial.angle }),
      ...(options.radial.center === undefined ? {} : { center: options.radial.center }),
      prefix,
      label: attribution.label,
      tag: attribution.tag,
    });
    return res.ok ? ok({ copy: res.value }) : err(kernelErrorToModelingError(res.error));
  }
  return err(modelingError('model-invalid-argument', 'linear or radial array options', {}));
}

export function rustSubdivide(
  store: RustEditMeshStore,
  faces: FaceSelector | undefined,
  options: SubdivideOptions,
  faceBudget: number,
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, faces);
  if (!ids.ok) return ids;
  const res = store.rustMesh.subdivide(ids.value, {
    levels: options.levels,
    ...(options.scheme === undefined ? {} : { scheme: options.scheme }),
    ...(options.boundary === undefined ? {} : { boundary: options.boundary }),
    ...(options.creaseSharpness === undefined ? {} : { creaseSharpness: options.creaseSharpness }),
    ...(Number.isFinite(faceBudget) ? { faceBudget } : {}),
  });
  return res.ok ? ok({ subdivided: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustTaper(
  store: RustEditMeshStore,
  target: FaceSelector,
  options: TaperOptions,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(target);
  if (!ids.ok) return ids;
  const res = store.rustMesh.taper(ids.value, {
    axis: options.axis,
    factor: options.factor,
    ...(options.axes === undefined ? {} : { axes: options.axes }),
    ...(options.range === undefined ? {} : { range: options.range }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  });
  return res.ok ? ok({ vertices: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustMarkEdges(
  store: RustEditMeshStore,
  edges: EdgeSelector,
  flag: typeof EDGE_SHARP | typeof EDGE_SEAM,
  set: boolean,
): Result<RoleCounts, ModelingError> {
  const ids = store.resolveSelector(edges);
  if (!ids.ok) return ids;
  const res = store.rustMesh.markEdges(ids.value, flag, set);
  return res.ok ? ok({ edges: ids.value.length }) : err(kernelErrorToModelingError(res.error));
}

export function rustUvProject(
  store: RustEditMeshStore,
  options: ProjectOptions & { readonly faces?: FaceSelector },
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, options.faces);
  if (!ids.ok) return ids;
  const res = store.rustMesh.projectUv(ids.value, {
    mode: options.mode,
    ...(options.axis === undefined ? {} : { axis: options.axis }),
    scale: options.scale,
    ...(options.channel === undefined ? {} : { channel: options.channel }),
  });
  return res.ok ? ok({ projected: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustUvUnwrap(
  store: RustEditMeshStore,
  options: UnwrapOptions & { readonly faces?: FaceSelector },
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, options.faces);
  if (!ids.ok) return ids;
  const res = store.rustMesh.unwrapUv(ids.value, {
    seams: options.seams === 'sharp' ? 'sharp' : 'marked',
    ...(options.channel === undefined ? {} : { channel: options.channel }),
  });
  return res.ok ? ok({ islands: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustUvPack(
  store: RustEditMeshStore,
  options: PackOptions & { readonly faces?: FaceSelector },
  paddingTexels: number,
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, options.faces);
  if (!ids.ok) return ids;
  const res = store.rustMesh.packUv(ids.value, {
    resolution: options.resolution,
    paddingTexels,
    normalize: options.normalize !== false,
    rotate: options.rotate !== false,
    ...(options.channel === undefined ? {} : { channel: options.channel }),
  });
  return res.ok ? ok({ islands: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustUvAuto(
  store: RustEditMeshStore,
  options: AutoUvOptions & { readonly faces?: FaceSelector },
  paddingTexels: number,
): Result<RoleCounts, ModelingError> {
  const ids = resolveRustFaces(store, options.faces);
  if (!ids.ok) return ids;
  const res = store.rustMesh.autoUv(ids.value, {
    ...(options.maxNormalDeviation === undefined
      ? {}
      : { maxNormalDeviation: options.maxNormalDeviation }),
    ...(typeof options.respectSharp === 'boolean' ? { respectSharp: options.respectSharp } : {}),
    resolution: options.resolution,
    paddingTexels,
    rotate: options.pack?.rotate !== false,
    ...(options.channel === undefined ? {} : { channel: options.channel }),
  });
  return res.ok ? ok({ charts: res.value }) : err(kernelErrorToModelingError(res.error));
}

export function rustBoolean(
  store: RustEditMeshStore,
  operation: Exclude<BooleanOperation, 'split'>,
  isSelf: boolean,
  operand: RustPeerMesh,
  tolerance: number,
): Result<RoleCounts, ModelingError> {
  if (isSelf) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the operand is another session, an FXEM snapshot or a selection',
        {},
      ),
    );
  }
  if (operand.poisoned !== undefined) {
    return err(
      modelingError(
        'model-precondition',
        'the operand session is not poisoned',
        { cause: operand.poisoned.code },
        'fix the operand session first; its first failure is in detail.cause',
      ),
    );
  }
  const borrowed = borrowPeerRustMesh(operand);
  if (!borrowed.ok) return borrowed;
  const { toolStore, tempStore } = borrowed.value;
  try {
    store.syncNameTablesFrom(toolStore);
    const res = store.rustMesh.booleanOp(toolStore.rustMesh, operation, tolerance);
    return res.ok ? ok({ faces: res.value }) : err(kernelErrorToModelingError(res.error));
  } finally {
    tempStore?.dispose();
  }
}

export function axisVectorOrTuple(axis: Axis | Tuple3): Tuple3 {
  return typeof axis === 'string' ? axisVector(axis) : axis;
}
