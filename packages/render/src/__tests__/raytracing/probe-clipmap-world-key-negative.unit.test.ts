import { describe, expect, it, vi } from 'vitest';
import {
  PROBE_ENTRY_FRESH,
  PROBE_ENTRY_INDEX,
  ProbeClipmapScheduler,
} from '../../raytracing/probe-clipmap';
import { worldKeyIncident, worldKeyTable } from './probe-clipmap-world-key.fixture';
import {
  negativeKeyFocus,
  negativeKeyNextFocus,
  negativeKeyPlan,
  negativeRemainderWitness,
  rawRemainderQueryOwner,
} from './probe-clipmap-world-key-negative.fixture';

describe('true negative cell and zero crossing controls', () => {
  it('rejects truncation at relative coordinate minus one quarter and independently fixes both windows', () => {
    const plan = negativeKeyPlan(),
      current = new ProbeClipmapScheduler(plan, negativeKeyFocus);
    expect(plan.origin).toEqual([0.5, -31.5, -31.5]);
    expect(current.windows().map((row) => row.window)).toEqual([[-3, 30, 30]]);
    const q = (negativeKeyNextFocus[0] - plan.origin[0]) / plan.spacing;
    expect(q).toBe(-0.25);
    expect(Math.floor(q) - 3).toBe(-4);
    expect(Math.trunc(q) - 3).toBe(-3);
    const truncated = new ProbeClipmapScheduler(plan, negativeKeyFocus);
    const floor = vi.spyOn(Math, 'floor').mockImplementation(Math.trunc);
    let missed: number;
    try {
      missed = truncated.focus(negativeKeyNextFocus);
    } finally {
      floor.mockRestore();
    }
    expect(missed).toBe(0);
    expect(truncated.windows().map((row) => row.window)).toEqual([[-3, 30, 30]]);
    expect(current.focus(negativeKeyNextFocus)).toBe(16);
    expect(current.windows().map((row) => row.window)).toEqual([[-4, 30, 30]]);
  });
  it('proves raw signed remainder conversion yields another finite cache row for this exact input', () => {
    expect(negativeRemainderWitness()).toEqual({
      cell: -4,
      dimension: 6,
      expected: 2,
      raw: 4294967292,
      expectedSlot: 32,
      wrongSlot: 26,
    });
    const plan = negativeKeyPlan(),
      current = new ProbeClipmapScheduler(plan, negativeKeyNextFocus);
    const rows = worldKeyTable(plan, current.windows()),
      correct = rows[32],
      wrong = rows[26];
    if (!correct || !wrong) throw new Error('Missing negative sampler color witness');
    expect(correct.key).not.toBe(wrong.key);
    expect(correct.ratio[0] - wrong.ratio[0]).toBe(1 / 512);
    expect(correct.ratio[1] - wrong.ratio[1]).toBe(1 / 1024);
    const source = 'prefix\nlet c = vec3u(((cell % d) + d) % d);\nsuffix';
    expect(rawRemainderQueryOwner(source)).toBe('prefix\nlet c = vec3u(cell % d);\nsuffix');
    expect(() => rawRemainderQueryOwner(source + source)).toThrow('one exact producer expression');
  });
  it('enumerates all sixteen true-negative exposed keys once with positive independent RGB marker', () => {
    const plan = negativeKeyPlan(),
      current = new ProbeClipmapScheduler(plan, negativeKeyFocus),
      old = worldKeyTable(plan, current.windows()),
      oldKeys = new Set(old.map((row) => row.key));
    current.commit(current.schedule());
    current.limit = 4;
    current.focus(negativeKeyNextFocus);
    const table = worldKeyTable(plan, current.windows()),
      fresh = table.filter((row) => !oldKeys.has(row.key)),
      seen = new Set<string>();
    expect(fresh).toHaveLength(16);
    expect(fresh.every((row) => row.cell[0] === -4 && row.position[0] === -3.5)).toBe(true);
    for (let frame = 0; frame < 4; frame++) {
      const work = current.schedule();
      expect(work.count).toBe(4);
      expect(work.fresh).toBe(4);
      for (const entry of work.list.subarray(0, work.count)) {
        expect(entry & PROBE_ENTRY_FRESH).not.toBe(0);
        const row = table[entry & PROBE_ENTRY_INDEX];
        if (!row) throw new Error('Missing negative key');
        expect(oldKeys.has(row.key)).toBe(false);
        expect(seen.has(row.key)).toBe(false);
        seen.add(row.key);
        const rgb = worldKeyIncident(row.position);
        expect(rgb.every((v) => v > 0)).toBe(true);
        expect(rgb[0] / rgb[1]).toBe(row.ratio[0]);
        expect(rgb[2] / rgb[1]).toBe(row.ratio[1]);
      }
      current.commit(work);
    }
    expect(seen).toEqual(new Set(fresh.map((row) => row.key)));
    expect(current.inspect().pendingExposedProbes).toBe(0);
  });
});
