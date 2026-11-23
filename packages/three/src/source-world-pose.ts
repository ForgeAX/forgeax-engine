import type { SynchronousTransform } from '@forgeax/engine-scene/internal';
import type { Matrix4, Object3D } from 'three/src/Three.Core.js';
import { matrixStorage, publishWorldMatrix } from './source-collections';

type PoseBinding = {
  transform: SynchronousTransform;
  publish: Set<() => void>;
};

const poses = new WeakMap<Object3D, PoseBinding>();
let boundPoses = 0;
// Used only with pinned stock kernels. User-owned matrix methods remain on
// Three's normal dispatch path.
const local = { elements: [] } as unknown as Matrix4;
const world = { elements: [] } as unknown as Matrix4;

/** Stock Object3D methods call this for their own row after updating any requested
 * ancestors. Virtual dispatch and the original descendant visit stay in Three. */
export function resolveSourceWorldPose(node: Object3D): boolean {
  if (boundPoses === 0) return false;
  const binding = poses.get(node);
  if (binding === undefined) return false;
  const parent = node.parent;
  if (binding.transform.resolve(parent === null ? null : poses.get(parent)?.transform)) {
    publishWorldMatrix(node.matrixWorld.elements);
    for (const publish of binding.publish) publish();
  }
  node.matrixWorldNeedsUpdate = false;
  return true;
}

export function sourceWorldRevision(node: Object3D): number | undefined {
  return poses.get(node)?.transform.revision || undefined;
}

export function resolveSourceLocalPose(node: Object3D): boolean {
  const transform = poses.get(node)?.transform;
  if (transform === undefined) return false;
  transform.resolveLocal();
  return true;
}

export function reflectSourceWorldPose(node: Object3D): void {
  poses.get(node)?.transform.replaceWorld();
}

/** Attach after the local inputs, output arrays and stock dispatch are observed.
 * The caller retires the binding before a method, flag or storage is replaced. */
export function bindSourceWorldPose(
  node: Object3D,
  State: typeof SynchronousTransform,
  publish: () => void,
) {
  const existing = poses.get(node);
  if (existing !== undefined) {
    existing.publish.add(publish);
    return { transform: existing.transform, release: () => releasePose(node, existing, publish) };
  }
  const compose = node.matrix.compose;
  const copy = node.matrixWorld.copy;
  const multiply = node.matrixWorld.multiplyMatrices;
  const localStorage = matrixStorage(node.matrix.elements);
  const worldStorage = matrixStorage(node.matrixWorld.elements);
  const transform = new State(
    () => {
      local.elements = localStorage;
      compose.call(local, node.position, node.quaternion, node.scale);
    },
    () => {
      local.elements = localStorage;
      world.elements = worldStorage;
      const parent = node.parent;
      if (parent === null) copy.call(world, local);
      else multiply.call(world, parent.matrixWorld, local);
    },
  );
  const binding = { transform, publish: new Set([publish]) };
  poses.set(node, binding);
  boundPoses++;
  return {
    transform,
    release: () => releasePose(node, binding, publish),
  };
}

function releasePose(node: Object3D, binding: PoseBinding, publish: () => void): void {
  if (!binding.publish.delete(publish) || binding.publish.size !== 0) return;
  poses.delete(node);
  boundPoses--;
}
