import { mat4, quat, vec3 } from '@forgeax/engine-math';
import {
  AttachedBindMode,
  Camera,
  DetachedBindMode,
  Matrix4,
  Object3D,
  Quaternion,
  RectAreaLight,
  SkinnedMesh,
  Vector3,
} from 'three/src/Three.Core.js';
import { unsupported } from './errors';
import type { SourceTransform } from './scene-state';
import { SourcePoseEdits } from './scene-walk';
import type { SceneChanges } from './source-changes';

export const POSE_LANES = 10;
const EMPTY_POSES = new Float64Array(0);
const RECORD_BLOCK_ROWS = 8;

/** A synchronous source walk validates all poses before it writes a native hierarchy. */
export class SourcePosePage {
  values = EMPTY_POSES;
  used = 0;
  private recordBlock = EMPTY_POSES;
  private recordOffset = 0;
  readonly pendingParents: (Object3D | undefined)[] = [];
  parentCount = 0;
  private capturedEdits?: SourcePoseEdits;
  private hierarchy?: Set<Object3D>;
  private tracked = false;

  /** Transfer the current inputs to this validation. Later source callbacks write to the next batch. */
  takeEdits(changes: SceneChanges): SourcePoseEdits {
    const edits = changes.pose;
    const hierarchy = changes.poseTopology;
    changes.pose = this.capturedEdits ?? new SourcePoseEdits();
    changes.poseTopology = this.hierarchy ?? new Set();
    this.capturedEdits = edits;
    this.hierarchy = hierarchy;
    this.tracked = true;
    return edits;
  }

  get capturedTopology(): Set<Object3D> | undefined {
    return this.tracked ? this.hierarchy : undefined;
  }

  reserve(rows: number, preserve = false): Float64Array {
    const required = rows * POSE_LANES;
    if (this.values.length < required) {
      const next = new Float64Array(Math.max(required, this.values.length * 2));
      if (preserve) next.set(this.values);
      this.values = next;
    }
    return this.values;
  }

  /** The node holds its exact source lanes. A surviving node pins at most eight poses. */
  issueRecord(): Float64Array {
    if (this.recordOffset === this.recordBlock.length) {
      this.recordBlock = new Float64Array(RECORD_BLOCK_ROWS * POSE_LANES);
      this.recordOffset = 0;
    }
    const start = this.recordOffset;
    this.recordOffset += POSE_LANES;
    return this.recordBlock.subarray(start, this.recordOffset);
  }

  /** All staged lanes are finite. Preserve both signed zeros and sub-f32 source edits. */
  matchesRecord(record: ArrayLike<number>, offset: number): boolean {
    if (record.length !== POSE_LANES) return false;
    const values = this.values;
    for (let i = 0; i < POSE_LANES; i++) {
      const previous = record[i] as number;
      const current = values[offset + i] as number;
      if (previous !== current || (current === 0 && 1 / previous !== 1 / current)) return false;
    }
    return true;
  }

  writeRecord(record: Float64Array, offset: number): void {
    const values = this.values;
    for (let i = 0; i < POSE_LANES; i++) record[i] = values[offset + i] as number;
  }

  release(residents: number): void {
    if (residents === 0) {
      this.recordBlock = EMPTY_POSES;
      this.recordOffset = 0;
    }
    this.capturedEdits?.release();
    this.hierarchy?.clear();
    this.tracked = false;
    this.used = 0;
    this.pendingParents.fill(undefined, 0, this.parentCount);
    this.parentCount = 0;
    if (residents === 0 || this.pendingParents.length > Math.max(128, residents * 2))
      this.pendingParents.length = 0;
    if (residents === 0 || this.values.length > Math.max(128, residents * 2) * POSE_LANES)
      this.values = EMPTY_POSES;
  }
}

/** Ten validated lanes in ECS Transform field order. Source objects retain double precision. */
export function writePose(
  pose: number[] | Float64Array,
  x: number,
  y: number,
  z: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  sx: number,
  sy: number,
  sz: number,
  preservePrecision = false,
  offset = 0,
): boolean {
  pose[offset] = x;
  pose[offset + 1] = y;
  pose[offset + 2] = z;
  pose[offset + 3] = qx;
  pose[offset + 4] = qy;
  pose[offset + 5] = qz;
  pose[offset + 6] = qw;
  pose[offset + 7] = sx;
  pose[offset + 8] = sy;
  pose[offset + 9] = sz;
  for (let i = offset; i < offset + POSE_LANES; i++) {
    const value = Math.fround(pose[i] as number);
    if (!Number.isFinite(value)) return false;
    if (!preservePrecision) pose[i] = value;
  }
  return Math.fround(sx) > 0 && Math.fround(sy) > 0 && Math.fround(sz) !== 0;
}

/** Read author TRS after the caller has matched it to the source matrices. */
export function readLocalPose(
  object: Object3D,
  pose: number[] | Float64Array,
  preservePrecision = false,
  offset = 0,
): boolean {
  const { position, quaternion, scale } = object;
  const { x, y, z, w } = quaternion;
  const { x: sx, y: sy, z: sz } = scale;
  if (sz <= 0) return false;
  const { x: px, y: py, z: pz } = position;
  return writePose(pose, px, py, pz, x, y, z, w, sx, sy, sz, preservePrecision, offset);
}

/** The stock world update can be reproduced from the observed local inputs. */
export function usesStockWorldUpdate(node: Object3D): boolean {
  return (
    node.updateMatrixWorld ===
    (node instanceof Camera
      ? Camera.prototype.updateMatrixWorld
      : node instanceof SkinnedMesh
        ? SkinnedMesh.prototype.updateMatrixWorld
        : Object3D.prototype.updateMatrixWorld)
  );
}

/** Legacy projections that require a positive similarity prove it from their source hierarchy. */
export function hasPositiveUniformSourceBasis(object: Object3D, unit = false): boolean {
  for (let node: Object3D | null = object; node !== null; node = node.parent) {
    const { x, y, z } = node.scale;
    if (
      !(x > 0 && x === y && x === z && Number.isFinite(x)) ||
      (unit && x !== 1) ||
      !node.matrixAutoUpdate ||
      !node.matrixWorldAutoUpdate ||
      node.pivot !== null ||
      node.updateMatrix !== Object3D.prototype.updateMatrix ||
      node.matrix.compose !== Matrix4.prototype.compose ||
      !usesStockWorldUpdate(node)
    )
      return false;
  }
  return true;
}

const cameraPosition = new Vector3();
const cameraRotation = new Quaternion();
const cameraScale = new Vector3();
const unitScale = new Vector3(1, 1, 1);

/** Reproduce the r187 Camera view-cache writer, including scale removal. */
export function stockCameraView(camera: Camera, out: Matrix4): Matrix4 {
  const world = camera.matrixWorld;
  world.decompose(cameraPosition, cameraRotation, cameraScale);
  if (cameraScale.equals(unitScale)) return out.copy(world).invert();
  return out.compose(cameraPosition, cameraRotation, unitScale).invert();
}

/** Stock camera view publication accepts only unit-scale ancestors. */
export function cameraPoseChain(camera: Camera): Set<Object3D> | null | undefined {
  let manual: Set<Object3D> | undefined;
  for (let node: Object3D | null = camera; node !== null; node = node.parent) {
    if (!node.matrixAutoUpdate) {
      manual ??= new Set();
      manual.add(node);
    } else if (node.scale.x !== 1 || node.scale.y !== 1 || node.scale.z !== 1) return null;
  }
  return manual;
}

export function canPublishLocalPose(node: Object3D): boolean {
  return (
    node.matrixWorldAutoUpdate &&
    node.pivot === null &&
    node.updateMatrix === Object3D.prototype.updateMatrix &&
    node.matrix.compose === Matrix4.prototype.compose &&
    node.matrixWorld.copy === Matrix4.prototype.copy &&
    node.matrixWorld.multiplyMatrices === Matrix4.prototype.multiplyMatrices &&
    usesStockWorldUpdate(node) &&
    (!(node instanceof SkinnedMesh) ||
      node.bindMode === AttachedBindMode ||
      node.bindMode === DetachedBindMode)
  );
}

const warnedTransformShear = new WeakSet<Object3D>();

export function decomposeSourceMatrix(
  object: Object3D,
  camera: Camera,
  values: readonly number[],
  skinWorldRevision: number | undefined,
): SourceTransform {
  // r187 removes camera scale when updating its view cache; manual view edits
  // and frozen inverses remain independent of the source world matrix.
  const matrix = object === camera ? camera.matrixWorldInverse.clone().invert().elements : values;
  // Three RectAreaLight emits along local -Z; native Rect emits along +Z.
  const affine =
    object instanceof RectAreaLight
      ? matrix.map((value, lane) => (lane >= 4 && lane < 12 ? -value : value))
      : matrix;
  const position = vec3.create(),
    rotation = quat.create(),
    scale = vec3.create(),
    shear = vec3.create();
  if (!mat4.decomposeAffine(position, rotation, scale, shear, affine))
    unsupported(
      'Object3D matrixWorld requires a finite nonsingular affine matrix',
      object.uuid,
    ).unwrap();
  if (
    object === camera &&
    (scale.some((value) => Math.abs(value - 1) > 1e-5) || hasSourceShear(shear))
  )
    unsupported(
      'Camera.matrixWorldInverse requires a rigid view; non-rigid views need native camera support',
      camera.uuid,
    ).unwrap();
  warnDiscardedShear(object, shear);
  return {
    values: [...values],
    data: { pos: position, quat: rotation, scale },
    skinWorldRevision,
  };
}

/** Separate authored shear from floating-point residuals in a nominal TRS matrix. */
export function hasSourceShear(shear: Float32Array): boolean {
  return shear.some((value) => Math.abs(value) > 1e-5);
}

function warnDiscardedShear(object: Object3D, shear: Float32Array): void {
  if (warnedTransformShear.has(object) || !hasSourceShear(shear)) return;
  warnedTransformShear.add(object);
  console.warn('[forgeax/three] Ignoring shear in Object3D.matrixWorld', object.uuid);
}
