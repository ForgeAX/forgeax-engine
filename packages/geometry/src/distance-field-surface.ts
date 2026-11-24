import { type MeshDistanceFieldSurface, ok, type Result } from '@forgeax/engine-types';
import { type DistanceFieldError, distanceFieldFailure } from './distance-field';
import { MAX_DISTANCE_FIELD_BYTES } from './distance-field-bricks';
import { validateTriangleSidedness } from './triangle-sidedness-storage';

const MAX_ELEMENTS = 1_048_576;
const finiteBounds = (view: DataView, node: number) => {
  for (let axis = 0; axis < 3; axis++) {
    const lo = view.getFloat32(node * 32 + axis * 4, true);
    const hi = view.getFloat32(node * 32 + 16 + axis * 4, true);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return false;
  }
  return true;
};
const first = (view: DataView, node: number) => view.getUint32(node * 32 + 28, true) >>> 2;
const count = (view: DataView, node: number) => view.getUint32(node * 32 + 28, true) & 3;
const subtreeEnd = (view: DataView, node: number) => view.getUint32(node * 32 + 12, true);

function integerCoordinate(view: DataView, coordinate: number): bigint {
  const word = view.getUint32(coordinate * 4, true),
    exponent = (word >>> 23) & 255;
  const significand = BigInt((word & 0x7fffff) | (exponent ? 0x800000 : 0));
  const magnitude = exponent ? significand << BigInt(exponent - 1) : significand;
  return word >>> 31 ? -magnitude : magnitude;
}

/** Exact zero-area decision over the source f32 bits on a common 2^-149 grid. */
function areaZero(view: DataView, a: number, b: number, c: number) {
  const u: bigint[] = [],
    v: bigint[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const from = integerCoordinate(view, a * 3 + axis);
    u.push(integerCoordinate(view, b * 3 + axis) - from);
    v.push(integerCoordinate(view, c * 3 + axis) - from);
  }
  const at = (values: readonly bigint[], i: number) => values[i] ?? 0n;
  return [0, 1, 2].every(
    (axis) =>
      at(u, (axis + 1) % 3) * at(v, (axis + 2) % 3) ===
      at(u, (axis + 2) % 3) * at(v, (axis + 1) % 3),
  );
}

/** One borrowed source view; callers must first validate finite canonical f32
 * positions and every vertex index. No floating subtraction decides zero area. */
export function createTriangleAreaTest(positions: Float32Array) {
  const view = new DataView(positions.buffer, positions.byteOffset, positions.byteLength);
  return (a: number, b: number, c: number) => areaZero(view, a, b, c);
}

function sourceValid(surface: MeshDistanceFieldSurface) {
  const vertices = surface.positions.length / 3,
    primitives = surface.indices.length / 3;
  const bytes =
    surface.positions.byteLength +
    surface.indices.byteLength +
    surface.triangleSidedness.byteLength +
    surface.nodes.byteLength +
    surface.primitiveOrder.byteLength;
  if (
    !Number.isInteger(vertices) ||
    vertices < 3 ||
    vertices > MAX_ELEMENTS ||
    !Number.isInteger(primitives) ||
    primitives < 1 ||
    primitives > MAX_ELEMENTS ||
    bytes > MAX_DISTANCE_FIELD_BYTES ||
    surface.primitiveOrder.length > primitives ||
    surface.positions.some((value) => !Number.isFinite(value)) ||
    surface.indices.some((index) => index >= vertices) ||
    !validateTriangleSidedness(surface.triangleSidedness, primitives).ok
  )
    return false;
  return true;
}

function rosterValid(surface: MeshDistanceFieldSurface) {
  const primitives = surface.indices.length / 3,
    seen = new Uint8Array(primitives);
  for (const primitive of surface.primitiveOrder) {
    if (primitive >= primitives || seen[primitive]) return false;
    seen[primitive] = 1;
  }
  const isZero = createTriangleAreaTest(surface.positions);
  for (let primitive = 0; primitive < primitives; primitive++) {
    const a = surface.indices[primitive * 3],
      b = surface.indices[primitive * 3 + 1],
      c = surface.indices[primitive * 3 + 2];
    if (a === undefined || b === undefined || c === undefined) return false;
    if ((seen[primitive] === 0) !== isZero(a, b, c)) return false;
  }
  return true;
}

function containsNode(view: DataView, parent: number, child: number) {
  for (let axis = 0; axis < 3; axis++)
    if (
      view.getFloat32(parent * 32 + axis * 4, true) >
        view.getFloat32(child * 32 + axis * 4, true) ||
      view.getFloat32(parent * 32 + 16 + axis * 4, true) <
        view.getFloat32(child * 32 + 16 + axis * 4, true)
    )
      return false;
  return true;
}

function leafValid(surface: MeshDistanceFieldSurface, view: DataView, node: number) {
  const lo = first(view, node),
    size = count(view, node);
  if (
    size === 3 ||
    lo + size > surface.primitiveOrder.length ||
    subtreeEnd(view, node) !== node + 1
  )
    return false;
  for (let row = lo; row < lo + size; row++) {
    const primitive = surface.primitiveOrder[row];
    if (primitive === undefined) return false;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = surface.indices[primitive * 3 + corner];
      if (vertex === undefined) return false;
      for (let axis = 0; axis < 3; axis++) {
        const value = surface.positions[vertex * 3 + axis];
        if (
          value === undefined ||
          value < view.getFloat32(node * 32 + axis * 4, true) ||
          value > view.getFloat32(node * 32 + 16 + axis * 4, true)
        )
          return false;
      }
    }
  }
  return true;
}

function branchEnd(view: DataView, node: number, total: number, ends: Uint32Array): number | null {
  const left = node + 1;
  if (left >= total) return null;
  const right = subtreeEnd(view, left);
  if (
    right >= subtreeEnd(view, node) ||
    right >= total ||
    subtreeEnd(view, right) !== subtreeEnd(view, node) ||
    first(view, node) !== first(view, left) ||
    ends[left] !== first(view, right) ||
    !containsNode(view, node, left) ||
    !containsNode(view, node, right)
  )
    return null;
  return ends[right] ?? null;
}

function treeValid(surface: MeshDistanceFieldSurface) {
  if (surface.nodes.byteLength % 32 || surface.nodes.byteLength === 0) return false;
  const total = surface.nodes.byteLength / 32,
    active = surface.primitiveOrder.length;
  if (active < 1 || total > 2 * active - 1) return false;
  const view = new DataView(
      surface.nodes.buffer,
      surface.nodes.byteOffset,
      surface.nodes.byteLength,
    ),
    ends = new Uint32Array(total);
  if (subtreeEnd(view, 0) !== total || first(view, 0) !== 0) return false;
  for (let node = total - 1; node >= 0; node--) {
    if (
      !finiteBounds(view, node) ||
      subtreeEnd(view, node) <= node ||
      subtreeEnd(view, node) > total
    )
      return false;
    if (count(view, node)) {
      if (!leafValid(surface, view, node)) return false;
      ends[node] = first(view, node) + count(view, node);
      continue;
    }
    const end = branchEnd(view, node, total, ends);
    if (end === null) return false;
    ends[node] = end;
  }
  return ends[0] === active;
}

/** Full bounded structural/source-coverage reader, independent of any packer's
 * region objects or builder internals. Every omitted primitive must be exactly
 * degenerate; a duplicate, wrong leaf or broken subtree is never repaired. */
export function validateDistanceFieldSurface(
  surface: MeshDistanceFieldSurface,
): Result<void, DistanceFieldError> {
  if (!sourceValid(surface))
    return distanceFieldFailure('invalid flat surface source topology or sidedness');
  if (!rosterValid(surface))
    return distanceFieldFailure(
      'flat surface primitive coverage is incomplete, duplicate or not exactly nondegenerate',
    );
  if (!treeValid(surface))
    return distanceFieldFailure(
      'flat surface BVH closure, leaf range or source bounds are invalid',
    );
  return ok(undefined);
}
