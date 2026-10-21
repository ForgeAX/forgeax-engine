import { RenderQueue } from '@forgeax/engine-types';
import type { FrameCacheCounters } from '../inspection-types';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { CameraSnapshot } from '../render-contract';
import type { DispatchEntry, DispatchList, MaterialSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import {
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from './transparent-sort-config';

export interface TransparentSortSource {
  readonly transform: { readonly world: Float32Array };
  readonly material?: MaterialSnapshot;
}

/**
 * Per-slot sort value. DISTANCE returns negated squared camera distance
 * (back-to-front); layer modes return the configured layer-local value.
 */
function transparentSortValue(
  entry: DispatchEntry,
  renderables: FrameList<TransparentSortSource>,
  mode: number,
  yzAlpha: number,
  camera: CameraSnapshot | undefined,
): number {
  const renderable = renderables.at(entry.renderableIndex);
  const w = renderable?.transform.world;
  if (mode === TRANSPARENT_SORT_MODE_DISTANCE) {
    if (w === undefined || camera === undefined) return 0;
    const camPos = camera.position;
    const dx = (w[12] ?? 0) - (camPos[0] ?? 0);
    const dy = (w[13] ?? 0) - (camPos[1] ?? 0);
    const dz = (w[14] ?? 0) - (camPos[2] ?? 0);
    return -(dx * dx + dy * dy + dz * dz);
  }
  const posY = w?.[13] ?? 0;
  const posZ = w?.[14] ?? 0;
  if (mode === TRANSPARENT_SORT_MODE_LAYER_Z) return posZ;
  const pivotAndSize = renderable?.material?.paramSnapshot?.pivotAndSize as
    | readonly number[]
    | undefined;
  const pivotY = pivotAndSize?.[1] ?? 0.5;
  const wy4 = w?.[4] ?? 0;
  const wy5 = w?.[5] ?? 1;
  const wy6 = w?.[6] ?? 0;
  const sizeY = Math.sqrt(wy4 * wy4 + wy5 * wy5 + wy6 * wy6);
  const footY = posY - pivotY * sizeY;
  if (mode === TRANSPARENT_SORT_MODE_LAYER_Y) return -footY;
  if (mode === TRANSPARENT_SORT_MODE_LAYER_YZ) return footY + yzAlpha * posZ;
  return posZ;
}

/**
 * Transparent draw ordering with a verified previous order.
 *
 * Queue-selected or blended slots are stably sorted by
 * (layer, value, materialHandle) for layer modes and by value for DISTANCE,
 * with ties kept in dispatch order. That order is unique, so the previous
 * permutation is reused exactly when every adjacent pair still satisfies it
 * under this frame's camera and transforms: an O(n) check instead of an
 * O(n log n) sort, and byte-identical to a fresh sort. Opaque slots are never
 * touched. When the source dispatch and the order are both unchanged the
 * previous result array is returned, keeping identity-keyed record caches
 * on their reuse path.
 */
export class TransparentSortCache {
  private slots: number[] = [];
  private order: number[] = [];
  private source: DispatchList | undefined;
  private value: DispatchEntry[] | undefined;
  private keys = new Float64Array(0);
  private hits = 0;
  private misses = 0;

  inspect(): FrameCacheCounters {
    return { hits: this.hits, misses: this.misses };
  }

  sort(
    dispatch: DispatchList,
    world: RenderResourceScope,
    cameras: readonly CameraSnapshot[],
    renderables: FrameList<TransparentSortSource>,
    sortAll = false,
  ): DispatchList {
    const cfg = world.transparentSort;
    const mode = cfg.mode;
    const slots: number[] = [];
    for (let i = 0; i < dispatch.length; i++) {
      const entry = dispatch.at(i);
      if (
        sortAll ||
        entry?.queue === RenderQueue.Transparent ||
        entry?.renderState?.blend !== undefined
      )
        slots.push(i);
    }
    if (slots.length <= 1) return dispatch;
    const camera = cameras[0];
    if (mode === TRANSPARENT_SORT_MODE_DISTANCE && camera === undefined) return dispatch;

    if (this.keys.length < dispatch.length) this.keys = new Float64Array(dispatch.length);
    const keys = this.keys;
    let finite = true;
    for (const slot of slots) {
      const value = transparentSortValue(
        dispatch.at(slot) as DispatchEntry,
        renderables,
        mode,
        cfg.yzAlpha,
        camera,
      );
      if (Number.isNaN(value)) finite = false;
      keys[slot] = value;
    }
    const compare = (a: number, b: number): number => {
      if (mode !== TRANSPARENT_SORT_MODE_DISTANCE) {
        const da = dispatch.at(a) as DispatchEntry;
        const db = dispatch.at(b) as DispatchEntry;
        if (da.layer !== db.layer) return da.layer - db.layer;
        const va = keys[a] as number;
        const vb = keys[b] as number;
        if (va < vb) return -1;
        if (va > vb) return 1;
        return da.materialHandle - db.materialHandle;
      }
      const va = keys[a] as number;
      const vb = keys[b] as number;
      if (va < vb) return -1;
      if (va > vb) return 1;
      return 0;
    };

    // NaN keys make the comparator inconsistent; only a fresh engine sort
    // reproduces that order, so they never take the verified path.
    if (finite && sameSlots(this.slots, slots) && this.orderHolds(compare)) {
      this.hits += 1;
      if (this.source === dispatch && this.value !== undefined) return this.value;
      const value = applyOrder(dispatch, slots, this.order);
      this.source = dispatch;
      this.value = value;
      return value;
    }
    this.misses += 1;
    const order = slots.slice().sort(compare);
    const value = applyOrder(dispatch, slots, order);
    this.slots = slots;
    this.order = order;
    this.source = dispatch;
    this.value = value;
    return value;
  }

  private orderHolds(compare: (a: number, b: number) => number): boolean {
    const order = this.order;
    for (let k = 1; k < order.length; k++) {
      const a = order[k - 1] as number;
      const b = order[k] as number;
      const c = compare(a, b);
      if (c > 0 || (c === 0 && a > b)) return false;
    }
    return true;
  }
}

function sameSlots(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

function applyOrder(
  dispatch: DispatchList,
  slots: readonly number[],
  order: readonly number[],
): DispatchEntry[] {
  const result = dispatch.slice();
  for (let k = 0; k < slots.length; k++) {
    result[slots[k] as number] = dispatch.at(order[k] as number) as DispatchEntry;
  }
  return result;
}
