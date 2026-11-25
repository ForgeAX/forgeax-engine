import type { SynchronousTransform } from '@forgeax/engine-scene/internal';
import type { Matrix4, Object3D } from 'three/src/Three.Core.js';
import {
  primitiveMatrixValues,
  publishWorldMatrix,
  sourceCollectionStorage,
} from './source-collections';

import {
  copyWorldMatrixElements,
  multiplyWorldMatrix,
  type WorldMatrixRow,
  worldMatrixRow,
} from './world-matrix-storage';

type Elements = Matrix4['elements'];
type PoseKernels = {
  compose: Matrix4['compose'];
  copy: Matrix4['copy'];
  multiply: Matrix4['multiplyMatrices'];
  composeElements(target: Elements, ...inputs: Parameters<Matrix4['compose']>): void;
  copyElements(target: Elements, source: Elements): void;
  multiplyWorldElements(left: Elements, right: Elements, row: WorldMatrixRow): void;
  multiplyElements(left: Elements, right: Elements, target: Elements): void;
};
let stock: PoseKernels | undefined;

/** Installed by the bundled Matrix4 definition. Capture identities before any game overrides. */
export function installPoseKernels(
  methods: Pick<Matrix4, 'compose' | 'copy' | 'multiplyMatrices'>,
  composeElements: PoseKernels['composeElements'],
  copyElements: PoseKernels['copyElements'],
  multiplyElements: PoseKernels['multiplyElements'],
  multiplyWorldElements: PoseKernels['multiplyWorldElements'],
): void {
  stock = {
    compose: methods.compose,
    copy: methods.copy,
    multiply: methods.multiplyMatrices,
    composeElements,
    copyElements,
    multiplyElements,
    multiplyWorldElements,
  };
}

type WorldOutput = {
  readonly storage: Elements;
  readonly row: WorldMatrixRow | undefined;
};
class PoseBinding implements WorldOutput {
  readonly transform: SynchronousTransform<WorldOutput>;
  owners = 0;
  listeners?: Set<() => void>;

  constructor(
    State: typeof SynchronousTransform,
    readonly elements: Elements,
    readonly storage: Elements,
    readonly row: WorldMatrixRow | undefined,
    composeLocal: () => void,
    composeWorld: (parent: WorldOutput | null | undefined) => void,
  ) {
    this.transform = new State<WorldOutput>(this, composeLocal, composeWorld);
  }
}

interface PoseStorage {
  get(node: Object3D): PoseBinding | undefined;
  set(node: Object3D, binding: PoseBinding | undefined): void;
}

const foreign = new WeakMap<Object3D, PoseBinding>();
let poses: PoseStorage = {
  get: (node) => foreign.get(node),
  set(node, binding) {
    if (binding === undefined) foreign.delete(node);
    else foreign.set(node, binding);
  },
};

/** The bundled Object3D owns its synchronous binding. A borrowed method or an
 * independently constructed object still resolves through its original storage. */
export function installSourcePoseStorage(install: (previous: PoseStorage) => PoseStorage): void {
  poses = install(poses);
}
let boundPoses = 0;
// Pinned Matrix4 kernels only use the elements property. Save and restore
// each view around dispatch so nested reads own their destination and no
// source backing remains reachable from these module-level receivers.
const local = { elements: [] } as unknown as Matrix4;
const world = { elements: [] } as unknown as Matrix4;
const left = { elements: [] } as unknown as Matrix4;

/** Stock Object3D methods call this for their own row after updating any requested
 * ancestors. Virtual dispatch and the original descendant visit stay in Three. */
export function resolveSourceWorldPose(node: Object3D): boolean {
  if (boundPoses === 0) return false;
  const binding = poses.get(node);
  if (binding === undefined) return false;
  const parent = node.parent;
  if (binding.transform.resolve(parent === null ? null : poses.get(parent)?.transform)) {
    publishWorldMatrix(binding.elements);
    if (binding.listeners) for (const publish of binding.listeners) publish();
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
  publish?: () => void,
) {
  const existing = poses.get(node);
  if (existing !== undefined) {
    return attachPose(node, existing, publish);
  }
  const compose = node.matrix.compose;
  const copy = node.matrixWorld.copy;
  const multiply = node.matrixWorld.multiplyMatrices;
  const elements = node.matrixWorld.elements;
  const localElements = node.matrix.elements;
  const localStorage = sourceCollectionStorage(localElements);
  const worldStorage = sourceCollectionStorage(elements);
  const kernels = stock;
  const row =
    kernels?.copy === copy && kernels.multiply === multiply
      ? worldMatrixRow(worldStorage)
      : undefined;
  row?.attach();
  const binding = new PoseBinding(
    State,
    elements,
    worldStorage,
    row,
    kernels?.compose === compose
      ? () => kernels.composeElements(localStorage, node.position, node.quaternion, node.scale)
      : () => {
          const previous = local.elements;
          local.elements = localStorage;
          try {
            compose.call(local, node.position, node.quaternion, node.scale);
          } finally {
            local.elements = previous;
          }
        },
    kernels?.copy === copy && kernels.multiply === multiply
      ? (parent) => {
          if (parent != null) {
            const parentLanes = parent.row?.lanes;
            if (
              parentLanes !== undefined &&
              row?.lanes !== undefined &&
              primitiveMatrixValues(localElements, localStorage)
            )
              multiplyWorldMatrix(parentLanes, localStorage, row.lanes);
            else if (row) kernels.multiplyWorldElements(parent.storage, localStorage, row);
            else kernels.multiplyElements(parent.storage, localStorage, worldStorage);
            return;
          }
          const foreign = parent === undefined ? node.parent?.matrixWorld : undefined;
          if (foreign) {
            const input = sourceCollectionStorage(foreign.elements);
            if (row) kernels.multiplyWorldElements(input, localStorage, row);
            else kernels.multiplyElements(input, localStorage, worldStorage);
          } else if (!row || !copyWorldMatrixElements(worldStorage, localStorage, localElements))
            kernels.copyElements(worldStorage, localStorage);
        }
      : (parent) => {
          // A foreign parent may update another hierarchy while returning its matrix.
          const foreign = parent === undefined ? node.parent?.matrixWorld : undefined;
          const previousLocal = local.elements;
          const previousWorld = world.elements;
          const previousLeft = left.elements;
          local.elements = localStorage;
          world.elements = worldStorage;
          try {
            if (parent != null) {
              left.elements = parent.storage;
              multiply.call(world, left, local);
            } else if (foreign) multiply.call(world, foreign, local);
            else copy.call(world, local);
          } finally {
            local.elements = previousLocal;
            world.elements = previousWorld;
            left.elements = previousLeft;
          }
        },
  );
  poses.set(node, binding);
  boundPoses++;
  return attachPose(node, binding, publish);
}

function attachPose(node: Object3D, binding: PoseBinding, publish?: () => void) {
  binding.owners++;
  // Each observer owns its attachment, including callers with the same callback.
  const listener = publish === undefined ? undefined : () => publish();
  if (listener) {
    binding.listeners ??= new Set();
    binding.listeners.add(listener);
  }
  let attached = true;
  return {
    transform: binding.transform,
    release: () => {
      if (!attached) return;
      attached = false;
      if (listener) binding.listeners?.delete(listener);
      if (--binding.owners === 0) {
        binding.row?.release();
        poses.set(node, undefined);
        boundPoses--;
      }
    },
  };
}
