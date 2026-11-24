import { describe, expect, it } from 'vitest';
import {
  PROBE_ENTRY_FRESH,
  PROBE_ENTRY_INDEX,
  ProbeClipmapScheduler,
} from '../../raytracing/probe-clipmap';
import {
  worldKeyFocus,
  worldKeyIncident,
  worldKeyNextFocus,
  worldKeyPlan,
  worldKeyTable,
} from './probe-clipmap-world-key.fixture';

describe('independent world-key witness', () => {
  it('enumerates96 unique legal half-integer world positions and independent marker ratios', () => {
    const plan = worldKeyPlan(),
      scheduler = new ProbeClipmapScheduler(plan, worldKeyFocus),
      rows = worldKeyTable(plan, scheduler.windows());
    expect(plan.origin).toEqual([-31.5, -31.5, -31.5]);
    expect(scheduler.windows().map((row) => row.window)).toEqual([[29, 30, 30]]);
    expect(rows).toHaveLength(96);
    expect(new Set(rows.map((r) => r.key)).size).toBe(96);
    for (const row of rows) {
      const signal = worldKeyIncident(row.position);
      expect(signal.every((v) => v > 0)).toBe(true);
      expect(signal[0] / signal[1]).toBe(row.ratio[0]);
      expect(signal[2] / signal[1]).toBe(row.ratio[1]);
    }
  });
  it('separates16 new world cells,4 accepted chunks and retained overlapping keys without a production index oracle', () => {
    const plan = worldKeyPlan(),
      scheduler = new ProbeClipmapScheduler(plan, worldKeyFocus);
    const old = worldKeyTable(plan, scheduler.windows()),
      keys = new Set(old.map((r) => r.key));
    scheduler.commit(scheduler.schedule());
    scheduler.limit = 4;
    expect(scheduler.focus(worldKeyNextFocus)).toBe(16);
    expect(scheduler.windows().map((row) => row.window)).toEqual([[30, 30, 30]]);
    const current = worldKeyTable(plan, scheduler.windows()),
      fresh = current.filter((row) => !keys.has(row.key)),
      seen = new Set<string>();
    expect(fresh).toHaveLength(16);
    for (let step = 0; step < 4; step++) {
      const work = scheduler.schedule();
      expect(work.count).toBe(4);
      expect(work.fresh).toBe(4);
      for (const entry of work.list.subarray(0, work.count)) {
        expect(entry & PROBE_ENTRY_FRESH).not.toBe(0);
        const row = current[entry & PROBE_ENTRY_INDEX];
        if (!row) throw new Error('Unknown scheduled world slot');
        expect(keys.has(row.key)).toBe(false);
        expect(seen.has(row.key)).toBe(false);
        seen.add(row.key);
      }
      scheduler.commit(work);
    }
    expect(seen).toEqual(new Set(fresh.map((r) => r.key)));
    expect(scheduler.inspect().pendingExposedProbes).toBe(0);
  });
});
