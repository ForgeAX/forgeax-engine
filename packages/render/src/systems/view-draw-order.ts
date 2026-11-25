import type { World } from '@forgeax/engine-ecs';

/** Ascending keys of a source-owned transparent draw. Render owns their view ordering. */
export type ViewDrawOrderKey = readonly [
  group: number,
  priority: number,
  depth: number,
  tie: number,
];

export interface ViewDrawOrderSource {
  group: number;
  priority: number;
  x: number;
  y: number;
  z: number;
  tie: number;
  authoredWorld: ArrayLike<number> | undefined;
}

export interface ViewDrawOrderSelection {
  readonly view: ArrayLike<number>;
  readLocal(entity: number, out: ViewDrawOrderSource): boolean;
}

/** One synchronous reader per phase. Only its four scalar keys escape into the sort. */
export class ViewDrawOrderReader implements ViewDrawOrderSource {
  group = 0;
  priority = 0;
  x = 0;
  y = 0;
  z = 0;
  tie = 0;
  authoredWorld: ArrayLike<number> | undefined;
  readonly key: [number, number, number, number] = [0, 0, 0, 0];

  read(
    order: ViewDrawOrderSelection,
    entity: number,
    renderedWorld: ArrayLike<number>,
    renderedOffset = 0,
  ): ViewDrawOrderKey | undefined {
    if (!order.readLocal(entity, this)) return undefined;
    const { group, priority, tie, x, y, z, authoredWorld } = this;
    this.authoredWorld = undefined;
    const w = authoredWorld ?? renderedWorld;
    const offset = authoredWorld === undefined ? renderedOffset : 0;
    const v = order.view;
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
    const key = this.key;
    key[0] = group;
    key[1] = priority;
    key[2] = depth;
    key[3] = tie;
    return key;
  }
}

const localOrders = new WeakMap<World, ViewDrawOrderSelection>();

/** The local producer supplies a new immutable view selection for each submission. */
export function setViewDrawOrder(world: World, order: ViewDrawOrderSelection | undefined): void {
  if (order === undefined) localOrders.delete(world);
  else localOrders.set(world, order);
}

export function viewDrawOrder(world: World | undefined): ViewDrawOrderSelection | undefined {
  return world === undefined ? undefined : localOrders.get(world);
}
