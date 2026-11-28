import { describe, expect, it } from 'vitest';
import { PENDING, ROWS } from './registry';
import { judgingSurface } from './surface';

// Every judging check either has a row that proves it can fail, or a pending entry that says why not.
describe('falsifier registry', () => {
  const surface = judgingSurface();
  const rowNames = ROWS.map((r) => r.check);
  const pendingNames = PENDING.map((p) => p.check);

  it('derives a non-empty judging surface from the export namespaces', () => {
    expect(surface.length).toBeGreaterThan(20);
  });

  it('covers every judging check with a row or a pending entry', () => {
    const covered = new Set([...rowNames, ...pendingNames]);
    expect(surface.filter((name) => !covered.has(name))).toEqual([]);
  });

  it('names only real judging checks in rows and pending entries', () => {
    const known = new Set(surface);
    expect([...rowNames, ...pendingNames].filter((name) => !known.has(name))).toEqual([]);
  });

  it('lists each check + variant once and gives every pending entry a reason', () => {
    const rowKeys = ROWS.map((r) => `${r.check}\u0000${r.variant ?? ''}`);
    expect(new Set(rowKeys).size).toBe(rowKeys.length);
    expect(new Set([...rowNames, ...pendingNames]).size).toBe(
      new Set(rowNames).size + pendingNames.length,
    );
    for (const entry of PENDING) expect(entry.reason.trim().length, entry.check).toBeGreaterThan(0);
  });

  for (const row of ROWS) {
    const label = row.variant === undefined ? row.check : `${row.check} [${row.variant}]`;
    it(`${label}: the pass input passes and the fail input fails with ${row.expect}`, () => {
      expect(row.pass().pass, `${label} pass input`).toBe(true);
      const failed = row.fail();
      expect(failed.pass, `${label} fail input`).toBe(false);
      expect(failed.codes, `${label} fail codes`).toContain(row.expect);
    });
  }
});
