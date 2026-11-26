import type { MeshGeometry } from './mesh-frame';

// Five handle bits per branch. Common address prefixes take no nodes.
// Only a changed path is copied; every leaf is the accepted geometry itself.
export type MeshDirectory = MeshGeometry | Branch;
class Branch {
  constructor(
    readonly first: number,
    readonly scale: number,
    readonly mask: number,
    readonly children: readonly (MeshDirectory | undefined)[],
  ) {}
}

const WIDTH = 32;
const TOP_STRIDE = 2 ** 50;
type Visit = (before: MeshGeometry | undefined, after: MeshGeometry | undefined) => void;

function address(node: MeshDirectory): number {
  return node instanceof Branch ? node.first / node.scale : node.handle;
}

function lane(node: Branch, handle: number): number {
  // Scale before subtracting to preserve all safe integer addresses across zero.
  return Math.floor(handle * node.scale) - node.first;
}

export function geometryAt(
  node: MeshDirectory | undefined,
  handle: number,
): MeshGeometry | undefined {
  while (node instanceof Branch) node = node.children[lane(node, handle)];
  return node?.handle === handle ? node : undefined;
}

function join(left: MeshDirectory, right: MeshGeometry): Branch {
  const a = address(left),
    b = right.handle;
  let stride = left instanceof Branch ? WIDTH / left.scale : 1;
  while (
    stride < TOP_STRIDE &&
    Math.floor(a / (stride * WIDTH)) !== Math.floor(b / (stride * WIDTH))
  )
    stride *= WIDTH;
  const base =
    stride === TOP_STRIDE ? -(2 ** 53) : Math.floor(a / (stride * WIDTH)) * (stride * WIDTH);
  const first = Math.floor(a / stride) - base / stride,
    second = Math.floor(b / stride) - base / stride;
  const children: MeshDirectory[] = [];
  children[first] = left;
  children[second] = right;
  return new Branch(base / stride, 1 / stride, (1 << first) | (1 << second), children);
}

export function publishGeometry(
  node: MeshDirectory | undefined,
  value: MeshGeometry,
): MeshDirectory {
  if (node === undefined) return value;
  if (!(node instanceof Branch)) return node.handle === value.handle ? value : join(node, value);
  const index = lane(node, value.handle);
  if (index < 0 || index >= WIDTH) return join(node, value);
  const previous = node.children[index];
  const next = publishGeometry(previous, value);
  if (next === previous) return node;
  const children = node.children.slice();
  children[index] = next;
  return new Branch(node.first, node.scale, node.mask | (1 << index), children);
}

export function removeGeometry(
  node: MeshDirectory | undefined,
  handle: number,
): MeshDirectory | undefined {
  if (node === undefined || !(node instanceof Branch))
    return node?.handle === handle ? undefined : node;
  const index = lane(node, handle);
  const previous = node.children[index];
  if (previous === undefined) return node;
  const next = removeGeometry(previous, handle);
  if (next === previous) return node;
  const mask = next === undefined ? node.mask & ~(1 << index) : node.mask;
  if ((mask & (mask - 1)) === 0) return node.children[31 - Math.clz32(mask)];
  const children = node.children.slice();
  children[index] = next;
  return new Branch(node.first, node.scale, mask, children);
}

function visitSubtree(node: MeshDirectory, removed: boolean, visit: Visit): void {
  if (!(node instanceof Branch)) {
    if (removed) visit(node, undefined);
    else visit(undefined, node);
    return;
  }
  for (let bits = node.mask; bits !== 0; bits &= bits - 1) {
    const child = node.children[31 - Math.clz32(bits & -bits)] as MeshDirectory;
    visitSubtree(child, removed, visit);
  }
}

function end(node: MeshDirectory): number {
  return node instanceof Branch ? (node.first + WIDTH) / node.scale : node.handle + 1;
}

/** Equal subtrees retain identity. Compressed branches align at their enclosing digit. */
export function visitGeometryChanges(
  before: MeshDirectory | undefined,
  after: MeshDirectory | undefined,
  visit: Visit,
): void {
  if (before === after) return;
  if (before === undefined) {
    if (after !== undefined) visitSubtree(after, false, visit);
    return;
  }
  if (after === undefined) {
    visitSubtree(before, true, visit);
    return;
  }
  if (end(before) <= address(after)) {
    visitSubtree(before, true, visit);
    visitSubtree(after, false, visit);
    return;
  }
  if (end(after) <= address(before)) {
    visitSubtree(after, false, visit);
    visitSubtree(before, true, visit);
    return;
  }
  if (!(before instanceof Branch) && !(after instanceof Branch)) {
    visit(before, after);
    return;
  }
  const left = before instanceof Branch ? before : undefined;
  const right = after instanceof Branch ? after : undefined;
  const outer =
    left !== undefined && (right === undefined || left.scale <= right.scale)
      ? left
      : (right as Branch);
  const a = left?.scale === outer.scale ? left : undefined;
  const b = right?.scale === outer.scale ? right : undefined;
  const oldLane = a === undefined ? lane(outer, address(before)) : -1;
  const newLane = b === undefined ? lane(outer, address(after)) : -1;
  const mask = (a?.mask ?? 1 << oldLane) | (b?.mask ?? 1 << newLane);
  for (let bits = mask; bits !== 0; bits &= bits - 1) {
    const i = 31 - Math.clz32(bits & -bits);
    visitGeometryChanges(
      i === oldLane ? before : a?.children[i],
      i === newLane ? after : b?.children[i],
      visit,
    );
  }
}
