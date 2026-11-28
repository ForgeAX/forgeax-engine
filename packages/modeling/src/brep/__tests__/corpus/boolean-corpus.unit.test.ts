import { describe, expect, it } from 'vitest';
import { CLASS_TITLES, CORPUS, type CorpusClass } from './boolean-corpus';
import { EXPECTED } from './boolean-corpus.expect';
import { type Observation, observeAll } from './boolean-corpus.observe';

const CLASSES = Object.keys(CLASS_TITLES) as CorpusClass[];

function summarise(rows: readonly Observation[]): string {
  const lines: string[] = [];
  const wrong = rows.filter((r) => r.outcome === 'wrong');
  for (const r of wrong) lines.push(`WRONG ${r.id}: ${r.key} (${r.detail})`);
  for (const cls of CLASSES) {
    const mine = rows.filter((r) => r.cls === cls);
    const ok = mine.filter((r) => r.outcome === 'ok').length;
    const refused = mine.filter((r) => r.outcome === 'refused').length;
    const bad = mine.filter((r) => r.outcome === 'wrong').length;
    const slow = mine.filter((r) => r.slow).length;
    lines.push(
      `class ${cls} ${CLASS_TITLES[cls].padEnd(40)} ok ${ok}  refused ${refused}  wrong ${bad}  slow ${slow}  of ${mine.length}`,
    );
  }
  for (const r of rows) {
    if (r.slow) lines.push(`SLOW ${r.id}: ${(r.ms / 1000).toFixed(1)} s`);
  }
  return lines.join('\n');
}

describe('boolean corpus', () => {
  it('every case has the pinned outcome and no case is wrong', () => {
    const rows = observeAll();
    const byId = new Map(rows.map((r) => [r.id, r]));
    process.stdout.write(`\n${summarise(rows)}\n`);

    const wrong = rows.filter((r) => r.outcome === 'wrong');
    expect(
      wrong.map((r) => `${r.id}: ${r.key} (${r.detail})`),
      'wrong results (volume or topology error) must be empty; they are fixed before anything else',
    ).toEqual([]);

    const mismatches: string[] = [];
    for (const c of CORPUS) {
      const row = byId.get(c.id);
      const pinned = EXPECTED[c.id];
      if (pinned === undefined) {
        mismatches.push(`${c.id}: no expectation pinned (observed ${row?.key})`);
      } else if (row === undefined || row.key !== pinned) {
        mismatches.push(`${c.id}: pinned ${pinned}, observed ${row?.key}`);
      }
    }
    for (const id of Object.keys(EXPECTED)) {
      if (!CORPUS.some((c) => c.id === id)) mismatches.push(`${id}: expectation has no case`);
    }
    expect(mismatches, 'outcome changed from the pinned table').toEqual([]);
  }, 300_000);
});
