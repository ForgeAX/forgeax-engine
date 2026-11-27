import type { packCardLookupProjections } from '../../raytracing/card-lookup';
import { rebuildCardOwnerIndex } from '../../raytracing/card-owner-index';
import { surfaceCardKey, writeCardLookupProjection } from '../../raytracing/surface-cards';

/** Retired c5c88a packer, used only as an observable wrong-upload control. */
export function retiredDenseCardProjections(
  ...[cache, sources, expected]: Parameters<typeof packCardLookupProjections>
) {
  const bytes = new Uint8Array(
    Math.max(
      1,
      cache.entries.reduce((n, entry) => n + entry.projections.length, 0),
    ) * 80,
  );
  let count = 0;
  for (const entry of cache.entries) {
    const source = expected.find((s) => s.instance.instanceId === entry.instanceId);
    const current = sources.find((s) => s.instanceId === entry.instanceId);
    const valid =
      source !== undefined &&
      current?.key === entry.geometryKey &&
      ('captureKey' in source ? source.captureKey : surfaceCardKey(source)) === entry.captureKey;
    for (const projection of entry.projections) {
      writeCardLookupProjection(bytes, count, projection, entry.instanceId, valid ? 1 : 0);
      count++;
    }
  }
  rebuildCardOwnerIndex(bytes, count);
  return { bytes, count };
}
