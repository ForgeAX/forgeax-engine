import type { LightRoster } from '../../render-system-extract';

/**
 * Local-light admission for the Standard Cluster.
 *
 * Over the cap the Cluster keeps the first N lights of one camera-independent
 * order and drops the rest, warning once; it never rejects the frame. Within
 * the cap the roster is passed through untouched, so the light slots keep
 * their extraction order.
 *
 * Here the order is kind (point, spot, rect), then world, entity index,
 * entity generation, and finally the extraction position for fixtures that
 * carry no entity. The kind grouping keeps the slot layout every consumer
 * relies on: points first, then spots at `point.length + spotIndex`, then rects.
 */

type CappedKinds = Pick<LightRoster, 'point' | 'spot' | 'rect'>;

/** The local lights one view's Cluster slots hold, and how many the cap dropped. */
export interface StandardClusterLocalLights {
  readonly kept: CappedKinds;
  /** Point, spot and rect lights before admission. */
  readonly requested: number;
  readonly dropped: number;
}

interface LocalLightIdentity {
  readonly entity?: unknown;
  readonly worldId?: number;
}

/** Local lights one Cluster frame may hold. */
export function standardLocalLightLimit(lightCount: number, slotCapacity: number): number {
  return Math.max(0, Math.min(lightCount, slotCapacity));
}

/** Point, spot and rect lights a roster carries before admission. */
export function standardLocalLightCount(lights: CappedKinds): number {
  return lights.point.length + lights.spot.length + lights.rect.length;
}

interface Ranked<T> {
  readonly light: T;
  readonly kind: number;
  readonly world: number;
  readonly index: number;
  readonly generation: number;
  readonly ordinal: number;
}

function rank<T extends LocalLightIdentity>(light: T, kind: number, ordinal: number): Ranked<T> {
  const entity = typeof light.entity === 'number' ? light.entity >>> 0 : undefined;
  return {
    light,
    kind,
    world: light.worldId ?? 0,
    index: entity === undefined ? Number.MAX_SAFE_INTEGER : entity & 0xffffff,
    generation: entity === undefined ? 0 : entity >>> 24,
    ordinal,
  };
}

function compareRanked(a: Ranked<unknown>, b: Ranked<unknown>): number {
  return (
    a.kind - b.kind ||
    a.world - b.world ||
    a.index - b.index ||
    a.generation - b.generation ||
    a.ordinal - b.ordinal
  );
}

/**
 * The first `limit` local lights in canonical order, regrouped by kind. The
 * caller's arrays are returned unchanged when the roster fits.
 */
export function capStandardLocalLights<T extends CappedKinds>(
  lights: T,
  limit: number,
): { readonly kept: CappedKinds; readonly dropped: number } {
  const total = standardLocalLightCount(lights);
  if (total <= limit) return { kept: lights, dropped: 0 };
  const ranked: Ranked<LocalLightIdentity>[] = [];
  let ordinal = 0;
  for (const light of lights.point) ranked.push(rank(light, 0, ordinal++));
  for (const light of lights.spot) ranked.push(rank(light, 1, ordinal++));
  for (const light of lights.rect) ranked.push(rank(light, 2, ordinal++));
  ranked.sort(compareRanked);
  const point: T['point'][number][] = [];
  const spot: T['spot'][number][] = [];
  const rect: T['rect'][number][] = [];
  for (let at = 0; at < limit; at++) {
    const entry = ranked[at] as Ranked<LocalLightIdentity>;
    if (entry.kind === 0) point.push(entry.light as T['point'][number]);
    else if (entry.kind === 1) spot.push(entry.light as T['spot'][number]);
    else rect.push(entry.light as T['rect'][number]);
  }
  return {
    kept: { point: Object.freeze(point), spot: Object.freeze(spot), rect: Object.freeze(rect) },
    dropped: total - limit,
  };
}

const admitted = new WeakMap<
  CappedKinds,
  StandardClusterLocalLights & { readonly limit: number }
>();

/**
 * The Cluster's view of `lights` under `limit`, computed once per roster
 * object and limit so every slot consumer (light table, volume, projector)
 * reads the same kept arrays and slot indices. Shadow producers keep reading
 * the full roster: a dropped light still renders its shadow map.
 */
export function standardClusterLocalLights(
  lights: CappedKinds,
  limit: number,
): StandardClusterLocalLights {
  const cached = admitted.get(lights);
  if (cached !== undefined && cached.limit === limit) return cached;
  const { kept, dropped } = capStandardLocalLights(lights, limit);
  const entry = { kept, requested: standardLocalLightCount(lights), dropped, limit };
  admitted.set(lights, entry);
  return entry;
}
