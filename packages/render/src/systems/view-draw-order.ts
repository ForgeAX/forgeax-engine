import type { World } from '@forgeax/engine-ecs';

/** Ascending keys of a source-owned transparent draw. Render owns their view ordering. */
export type ViewDrawOrderKey = readonly [
  group: number,
  priority: number,
  depth: number,
  tie: number,
];

export interface ViewDrawOrderSource {
  readonly group: number;
  readonly priority: number;
  readonly center: readonly [number, number, number];
  readonly tie: number;
  /** Source anchors whose authored pose differs from the rendered geometry pose. */
  readonly authoredWorld?: ArrayLike<number>;
}

export interface ViewDrawOrder {
  /** The source submission's view, shared by its derived passes. */
  readonly view: ArrayLike<number>;
  localFor(entity: number): ViewDrawOrderSource | undefined;
}

export interface ViewDrawOrderSelection extends ViewDrawOrder {
  readonly keys: Map<number, ViewDrawOrderKey>;
}

export function resolveViewDrawOrder(
  order: ViewDrawOrderSelection,
  entity: number,
  renderedWorld: ArrayLike<number>,
  renderedOffset = 0,
): ViewDrawOrderKey | undefined {
  const { keys } = order;
  const previous = keys.get(entity);
  if (previous !== undefined) return previous;
  const local = order.localFor(entity);
  if (local === undefined) return undefined;
  const w = local.authoredWorld ?? renderedWorld;
  const offset = local.authoredWorld === undefined ? renderedOffset : 0;
  const v = order.view;
  const [x, y, z] = local.center;
  const wx =
    (w[offset + 0] as number) * x +
    (w[offset + 4] as number) * y +
    (w[offset + 8] as number) * z +
    (w[offset + 12] as number);
  const wy =
    (w[offset + 1] as number) * x +
    (w[offset + 5] as number) * y +
    (w[offset + 9] as number) * z +
    (w[offset + 13] as number);
  const wz =
    (w[offset + 2] as number) * x +
    (w[offset + 6] as number) * y +
    (w[offset + 10] as number) * z +
    (w[offset + 14] as number);
  const ww =
    (w[offset + 3] as number) * x +
    (w[offset + 7] as number) * y +
    (w[offset + 11] as number) * z +
    (w[offset + 15] as number);
  const depth =
    ((v[2] as number) * wx +
      (v[6] as number) * wy +
      (v[10] as number) * wz +
      (v[14] as number) * ww) /
    ((v[3] as number) * wx +
      (v[7] as number) * wy +
      (v[11] as number) * wz +
      (v[15] as number) * ww);
  const key: ViewDrawOrderKey = [local.group, local.priority, depth, local.tie];
  keys.set(entity, key);
  return key;
}

const localOrders = new WeakMap<World, ViewDrawOrderSelection>();

/** The local producer supplies a new immutable view selection for each submission. */
export function setViewDrawOrder(world: World, order: ViewDrawOrder | undefined): void {
  if (order === undefined) localOrders.delete(world);
  else localOrders.set(world, { ...order, keys: new Map() });
}

export function viewDrawOrder(world: World | undefined): ViewDrawOrderSelection | undefined {
  return world === undefined ? undefined : localOrders.get(world);
}
