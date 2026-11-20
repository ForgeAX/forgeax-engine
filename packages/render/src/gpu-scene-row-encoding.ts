import { LIGHTING_CHANNELS_DEFAULT } from './components/lighting-channels';
import { GPU_MATERIAL_DESCRIPTOR, GPU_MESH_DESCRIPTOR } from './gpu-scene-inputs';
import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from './gpu-scene-schema';
import type { MaterialSnapshot, RenderableSnapshot } from './render-system-extract';
import type { MeshGeometry } from './scene/mesh-frame';
import type { RenderSceneRecord } from './scene/render-scene-types';
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
});

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
  source: RenderableSnapshot,
  allocation: {
    readonly transformStart: number;
    readonly instanceStart: number;
    readonly instanceCount: number;
    readonly materialSlot: number;
    readonly sharedGeometry: boolean;
  },
  temporalFlags: number,
): void {
  const layout = GPU_SCENE_LAYOUTS.primitive;
  const field = (name: string) => gpuSceneFieldOffset(layout, name);
  const flags = GPU_SCENE_PRIMITIVE_FLAGS;
  const bounds = source.localAabb;
  target.setUint32(field('generation'), record.generation, true);
  target.setUint32(
    field('flags'),
    flags.active |
      (bounds === undefined ? 0 : flags.bounds) |
      (allocation.sharedGeometry ? flags.sharedGeometry : 0) |
      (source.gpuDrivenDraws === undefined ? 0 : flags.gpuDriven) |
      (source.capsuleShadowRequested === true ? flags.capsuleShadow : 0) |
      (source.shadowReceiver === false ? flags.noShadowReceive : 0) |
      temporalFlags,
    true,
  );
  target.setUint32(field('transformIndex'), allocation.transformStart, true);
  target.setUint32(field('materialIndex'), allocation.materialSlot, true);
  target.setUint32(field('instanceStart'), allocation.instanceStart, true);
  target.setUint32(field('instanceCount'), allocation.instanceCount, true);
  target.setUint32(field('sourceIndex'), record.slot, true);
  target.setUint32(
    field('lightingChannels'),
    source.lightingChannels ?? LIGHTING_CHANNELS_DEFAULT,
    true,
  );
  const minOffset = field('localBoundsMin');
  const maxOffset = field('localBoundsMax');
  // lightingChannels occupies the word after the minimum's three axes.
  for (let axis = 0; axis < 3; axis++) {
    target.setFloat32(minOffset + axis * 4, bounds?.[axis] ?? 0, true);
    target.setFloat32(maxOffset + axis * 4, bounds?.[axis + 3] ?? 0, true);
  }
  target.setFloat32(maxOffset + 12, 0, true);
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
