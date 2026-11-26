/** Frame inspection retains the published bundle fields alongside direct geometry counts. */
export interface RenderBundleCounters {
  hits: number;
  misses: number;
  /** Draw calls visited by the recorder in cacheable segments, including hits. */
  visitedDraws?: number;
  /** Retained native bundles executed without emitting the retained geometry commands again. */
  preparedHits?: number;
  geometry?: GeometryRecordingTotals;
}

export type GeometryRecordingReason =
  | 'direct'
  | 'transient'
  | 'first'
  | 'layout'
  | 'resources'
  | 'pipeline'
  | 'replayed';

export type GeometryRecordingTotals = Record<
  string,
  Partial<Record<GeometryRecordingReason, { ranges: number; draws: number }>>
>;

export function countDirectGeometry(
  counters: RenderBundleCounters | undefined,
  pass: string,
  draws: number,
): void {
  if (counters === undefined) return;
  counters.geometry ??= {};
  const totals = counters.geometry;
  totals[pass] ??= {};
  const reasons = totals[pass];
  reasons.direct ??= { ranges: 0, draws: 0 };
  reasons.direct.ranges++;
  reasons.direct.draws += draws;
}
