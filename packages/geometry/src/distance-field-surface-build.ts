import { type MeshDistanceFieldSurface, ok, type Result } from '@forgeax/engine-types';
import { type DistanceFieldError, distanceFieldFailure } from './distance-field';
import { MAX_DISTANCE_FIELD_BYTES } from './distance-field-bricks';
import { validateDistanceFieldSurface } from './distance-field-surface';
import type { createTriangleQuery } from './triangle-query';
import { packTriangleSidedness } from './triangle-sidedness-storage';

type Tree = ReturnType<ReturnType<typeof createTriangleQuery>['snapshot']>;
const metadataValid = (node: Tree['nodes'][number], index: number, total: number) =>
  Number.isInteger(node.first) &&
  node.first >= 0 &&
  node.first < 0x40000000 &&
  Number.isInteger(node.count) &&
  node.count >= 0 &&
  node.count <= 2 &&
  Number.isInteger(node.escape) &&
  node.escape > index &&
  node.escape <= total;

function writeNodes(tree: Tree, nodes: Uint8Array): boolean {
  const view = new DataView(nodes.buffer, nodes.byteOffset, nodes.byteLength);
  for (const [index, node] of tree.nodes.entries()) {
    if (!metadataValid(node, index, tree.nodes.length)) return false;
    for (const axis of [0, 1, 2] as const) {
      const lo = node.min[axis],
        hi = node.max[axis];
      if (
        !Number.isFinite(lo) ||
        !Number.isFinite(hi) ||
        Math.fround(lo) !== lo ||
        Math.fround(hi) !== hi ||
        lo > hi
      )
        return false;
      view.setFloat32(index * 32 + axis * 4, lo, true);
      view.setFloat32(index * 32 + 16 + axis * 4, hi, true);
    }
    view.setUint32(index * 32 + 12, node.escape, true);
    view.setUint32(index * 32 + 28, node.first * 4 + node.count, true);
  }
  return true;
}

/** Converts the one producer-owned query tree to an explicit flat format. The
 * tree's internal objects are never serialized, retained or used as a registry.
 * All source channels are owned copies, and the independent reader gates output. */
export function buildDistanceFieldSurface(
  positions: Float32Array,
  indices: Uint32Array,
  sidedness: Uint8Array,
  tree: Tree,
  originalPrimitives: readonly number[],
): Result<MeshDistanceFieldSurface, DistanceFieldError> {
  const flags = packTriangleSidedness(sidedness);
  if (!flags.ok) return flags;
  const bytes =
    positions.byteLength +
    indices.byteLength +
    flags.value.byteLength +
    tree.nodes.length * 32 +
    tree.order.byteLength;
  if (bytes > MAX_DISTANCE_FIELD_BYTES)
    return distanceFieldFailure(
      'flat surface exceeds existing derived-field byte budget',
      'distance-field-limit',
    );
  const nodes = new Uint8Array(tree.nodes.length * 32),
    primitiveOrder = new Uint32Array(tree.order.length);
  for (const [row, active] of tree.order.entries()) {
    const primitive = originalPrimitives[active];
    if (
      primitive === undefined ||
      !Number.isInteger(primitive) ||
      primitive < 0 ||
      primitive >= indices.length / 3
    )
      return distanceFieldFailure('flat surface builder lost canonical source primitive identity');
    primitiveOrder[row] = primitive;
  }
  if (!writeNodes(tree, nodes))
    return distanceFieldFailure('flat surface builder cannot preserve exact source node bounds');
  const surface = {
    positions: positions.slice(),
    indices: indices.slice(),
    triangleSidedness: flags.value,
    nodes,
    primitiveOrder,
  };
  const valid = validateDistanceFieldSurface(surface);
  return valid.ok ? ok(surface) : valid;
}
