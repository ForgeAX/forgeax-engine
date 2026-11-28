import { LIGHTING_CHANNELS_DEFAULT } from './components/lighting-channels';
import { GPU_MATERIAL_DESCRIPTOR, GPU_MESH_DESCRIPTOR } from './gpu-scene-inputs';
import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from './gpu-scene-schema';
import type { GpuTableWrites } from './gpu-table-writes';
import type { MaterialSnapshot } from './render-system-extract';
import type { MeshGeometry } from './scene/mesh-frame';
import type { RenderSceneRecord } from './scene/render-scene-types';
import type { RowContent } from './scene/row-contents';
import { materialDisplacementRadius } from './standard-displacement-bounds';

export const GPU_SCENE_PRIMITIVE_FLAGS = Object.freeze({
  active: 1,
  bounds: 2,
  gpuDriven: 4,
  reactive: 8,
  motionInvalid: 16,
  noShadowReceive: 32,
  sharedGeometry: 64,
  capsuleShadow: 128,
  noShadowCast: 256,
  skipFrustum: 512,
});

const PRIMITIVE_LAYOUT = GPU_SCENE_LAYOUTS.primitive;
const GENERATION = gpuSceneFieldOffset(PRIMITIVE_LAYOUT, 'generation');
const PRIMITIVE_FLAGS = gpuSceneFieldOffset(PRIMITIVE_LAYOUT, 'flags');
const ROOT_TRANSFORM = gpuSceneFieldOffset(PRIMITIVE_LAYOUT, 'transformIndex');
const MATERIAL_INDEX = gpuSceneFieldOffset(PRIMITIVE_LAYOUT, 'materialIndex');
const INSTANCE_START = gpuSceneFieldOffset(PRIMITIVE_LAYOUT, 'instanceStart');
const INSTANCE_COUNT = gpuSceneFieldOffset(PRIMITIVE_LAYOUT, 'instanceCount');
const SOURCE_INDEX = gpuSceneFieldOffset(PRIMITIVE_LAYOUT, 'sourceIndex');
const LIGHTING_CHANNELS = gpuSceneFieldOffset(PRIMITIVE_LAYOUT, 'lightingChannels');
const BOUNDS_MIN = gpuSceneFieldOffset(PRIMITIVE_LAYOUT, 'localBoundsMin');
const BOUNDS_MAX = gpuSceneFieldOffset(PRIMITIVE_LAYOUT, 'localBoundsMax');

const TRANSFORM = GPU_SCENE_LAYOUTS.transform;
const INSTANCE = GPU_SCENE_LAYOUTS.instance;
const CURRENT = gpuSceneFieldOffset(TRANSFORM, 'currentWorld');
const PREVIOUS = gpuSceneFieldOffset(TRANSFORM, 'previousIndex');
const STAMP = gpuSceneFieldOffset(TRANSFORM, 'stamp');
const PRIMITIVE = gpuSceneFieldOffset(INSTANCE, 'primitiveIndex');
const LOCAL = gpuSceneFieldOffset(INSTANCE, 'transformIndex');
const CUSTOM = gpuSceneFieldOffset(INSTANCE, 'customDataStart');
const FLAGS = gpuSceneFieldOffset(INSTANCE, 'flags');

/** Geometry/material selection is performed by the caller's existing owner. */
export function encodeScenePrimitive(
  target: DataView,
  record: RenderSceneRecord,
  source: RowContent,
  allocation: {
    readonly transformStart: number;
    readonly instanceStart: number;
    readonly instanceCount: number;
    readonly materialSlot: number;
    readonly sharedGeometry: boolean;
  },
  temporalFlags: number,
): void {
  const flags = GPU_SCENE_PRIMITIVE_FLAGS;
  const bounds = source.localAabb;
  target.setUint32(GENERATION, record.generation, true);
  target.setUint32(
    PRIMITIVE_FLAGS,
    flags.active |
      (bounds === undefined ? 0 : flags.bounds) |
      (allocation.sharedGeometry ? flags.sharedGeometry : 0) |
      (source.gpuDrivenDraws === undefined ? 0 : flags.gpuDriven) |
      (source.capsuleShadowRequested === true ? flags.capsuleShadow : 0) |
      (source.shadowReceiver === false ? flags.noShadowReceive : 0) |
      (source.shadowCaster === false ? flags.noShadowCast : 0) |
      (source.frustumCulled === false ? flags.skipFrustum : 0) |
      temporalFlags,
    true,
  );
  target.setUint32(ROOT_TRANSFORM, allocation.transformStart, true);
  target.setUint32(MATERIAL_INDEX, allocation.materialSlot, true);
  target.setUint32(INSTANCE_START, allocation.instanceStart, true);
  target.setUint32(INSTANCE_COUNT, allocation.instanceCount, true);
  target.setUint32(SOURCE_INDEX, record.slot, true);
  target.setUint32(LIGHTING_CHANNELS, source.lightingChannels ?? LIGHTING_CHANNELS_DEFAULT, true);
  // lightingChannels occupies the word after the minimum's three axes.
  for (let axis = 0; axis < 3; axis++) {
    target.setFloat32(BOUNDS_MIN + axis * 4, bounds?.[axis] ?? 0, true);
    target.setFloat32(BOUNDS_MAX + axis * 4, bounds?.[axis + 3] ?? 0, true);
  }
  target.setFloat32(BOUNDS_MAX + 12, 0, true);
}

export function encodeMaterialSceneDescriptor(
  target: DataView,
  payload: number,
  source: MaterialSnapshot,
): void {
  target.setUint32(GPU_MATERIAL_DESCRIPTOR.payload * 4, payload, true);
  target.setFloat32(GPU_MATERIAL_DESCRIPTOR.radius * 4, materialDisplacementRadius(source), true);
  target.setUint32(
    GPU_MATERIAL_DESCRIPTOR.positionBounds * 4,
    source.positionBounds === 'standard-input' ? 1 : 0,
    true,
  );
}

export function encodeMeshSceneDescriptor(
  target: DataView,
  descriptor: number,
  geometry: MeshGeometry,
): void {
  target.setUint32(
    GPU_MESH_DESCRIPTOR.flags * 4,
    geometry.bounds === undefined ? 0 : GPU_SCENE_PRIMITIVE_FLAGS.bounds,
    true,
  );
  for (let axis = 0; axis < 3; axis++) {
    target.setFloat32((GPU_MESH_DESCRIPTOR.min + axis) * 4, geometry.bounds?.[axis] ?? 0, true);
    target.setFloat32((GPU_MESH_DESCRIPTOR.max + axis) * 4, geometry.bounds?.[axis + 3] ?? 0, true);
  }
  target.setUint32(
    GPU_MESH_DESCRIPTOR.skinEnvelopes * 4,
    geometry.skinEnvelopes === undefined ? 0 : descriptor + GPU_MESH_DESCRIPTOR.words,
    true,
  );
}

/** New/reset poses read themselves as previous, independent of later frame-stamp changes. */
export function encodeResetSceneTransform(
  target: DataView,
  byteOffset: number,
  index: number,
  matrix: ArrayLike<number>,
  sourceOffset: number,
  stamp: number,
): void {
  const current = byteOffset + CURRENT;
  for (let word = 0; word < 16; word++)
    target.setFloat32(current + word * 4, matrix[sourceOffset + word] ?? 0, true);
  target.setUint32(byteOffset + PREVIOUS, index, true);
  target.setUint32(byteOffset + STAMP, stamp, true);
}

function writeChangedU32(target: DataView, offset: number, value: number): boolean {
  if (target.getUint32(offset, true) === value) return false;
  target.setUint32(offset, value, true);
  return true;
}

/** Same numeric metadata ABI for ordinary and privately prepared instance rows. */
export function encodeSceneInstance(
  target: DataView,
  byteOffset: number,
  primitive: number,
  transform: number,
  customData: number,
  flags: number,
): boolean {
  const a = writeChangedU32(target, byteOffset + PRIMITIVE, primitive);
  const b = writeChangedU32(target, byteOffset + LOCAL, transform);
  const c = writeChangedU32(target, byteOffset + CUSTOM, customData);
  const d = writeChangedU32(target, byteOffset + FLAGS, flags);
  return a || b || c || d;
}

export function writeMat4(
  view: DataView,
  byteOffset: number,
  value: Float32Array,
  sourceOffset = 0,
): void {
  for (let lane = 0; lane < 16; lane += 1) {
    view.setFloat32(byteOffset + lane * 4, value[sourceOffset + lane] ?? 0, true);
  }
}

export function writeChangedMat4(
  view: DataView,
  byteOffset: number,
  matrix: Float32Array,
  sourceOffset = 0,
): boolean {
  let changed = false;
  for (let lane = 0; lane < 16; lane += 1) {
    const at = byteOffset + lane * 4;
    const value = matrix[sourceOffset + lane] ?? 0;
    if (Object.is(view.getFloat32(at, true), value)) continue;
    view.setFloat32(at, value, true);
    changed = true;
  }
  return changed;
}

/** Zero `count` rows from `start` and mark them for upload. */
export function clearRows(
  bytes: Uint8Array,
  stride: number,
  start: number,
  count: number,
  writes: GpuTableWrites,
): void {
  if (count <= 0) return;
  bytes.fill(0, start * stride, (start + count) * stride);
  writes.addRange(start, start + count);
}
