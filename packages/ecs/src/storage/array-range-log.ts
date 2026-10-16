/**
 * Bounded per-(entity, component, field) history of in-place array range
 * writes. `World.setArrayRange` appends one entry per successful write;
 * projection consumers ask which element ranges changed after an epoch.
 *
 * The log is only authoritative while its newest entry is the field's current
 * changed epoch: any other write (`set`, spans, add/replace) publishes a newer
 * epoch and every query then answers `'whole'` until the next range write
 * restarts the log.
 */

/** Half-open element range `[start, end)` of one array field. */
export interface ArrayRange {
  readonly start: number;
  readonly end: number;
}

/** Changed element ranges after an epoch, or `'whole'` when unknown. */
export type ArrayRangesChange = readonly ArrayRange[] | 'whole';

const ARRAY_RANGE_LOG_CAPACITY = 1024;

interface FieldRangeLog {
  /** Every change at or before this epoch is outside the log. */
  baseEpoch: number;
  epochs: number[];
  starts: number[];
  ends: number[];
}

/** Per-World owner of the range logs; keyed by live entity handle. */
export class ArrayRangeLog {
  private readonly byEntity = new Map<number, Map<string, FieldRangeLog>>();

  /**
   * Record one range write at `epoch`. `previousEpoch` is the field's changed
   * epoch before this write; a gap to the log's newest entry restarts it.
   */
  record(
    entity: number,
    componentId: number,
    field: string,
    previousEpoch: number,
    epoch: number,
    start: number,
    end: number,
  ): void {
    let fields = this.byEntity.get(entity);
    if (fields === undefined) {
      fields = new Map();
      this.byEntity.set(entity, fields);
    }
    const key = `${componentId}:${field}`;
    let log = fields.get(key);
    if (log === undefined || lastEpoch(log) !== previousEpoch) {
      log = { baseEpoch: previousEpoch, epochs: [], starts: [], ends: [] };
      fields.set(key, log);
    }
    if (log.epochs.length >= ARRAY_RANGE_LOG_CAPACITY) {
      const drop = log.epochs.length >> 1;
      log.baseEpoch = log.epochs[drop - 1] ?? log.baseEpoch;
      log.epochs.splice(0, drop);
      log.starts.splice(0, drop);
      log.ends.splice(0, drop);
    }
    log.epochs.push(epoch);
    log.starts.push(start);
    log.ends.push(end);
  }

  /**
   * Merged ranges written after `since`, provided `currentEpoch` (the field's
   * changed epoch now) is the log's newest entry.
   */
  changedSince(
    entity: number,
    componentId: number,
    field: string,
    since: number,
    currentEpoch: number,
  ): ArrayRangesChange {
    if (currentEpoch <= since) return [];
    const log = this.byEntity.get(entity)?.get(`${componentId}:${field}`);
    if (log === undefined || since < log.baseEpoch || lastEpoch(log) !== currentEpoch) {
      return 'whole';
    }
    let first = log.epochs.length;
    while (first > 0 && (log.epochs[first - 1] ?? 0) > since) first -= 1;
    const ranges: ArrayRange[] = [];
    for (let index = first; index < log.epochs.length; index += 1) {
      ranges.push({ start: log.starts[index] ?? 0, end: log.ends[index] ?? 0 });
    }
    return mergeArrayRanges(ranges);
  }

  /** Forget every log of an entity leaving the World. */
  forget(entity: number): void {
    this.byEntity.delete(entity);
  }
}

function lastEpoch(log: FieldRangeLog): number {
  return log.epochs[log.epochs.length - 1] ?? log.baseEpoch;
}

/** Sort and coalesce overlapping or touching ranges. */
export function mergeArrayRanges(ranges: ArrayRange[]): ArrayRange[] {
  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a.start - b.start);
  const merged: ArrayRange[] = [];
  let current = ranges[0] as ArrayRange;
  for (let index = 1; index < ranges.length; index += 1) {
    const next = ranges[index] as ArrayRange;
    if (next.start <= current.end) {
      if (next.end > current.end) current = { start: current.start, end: next.end };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}
