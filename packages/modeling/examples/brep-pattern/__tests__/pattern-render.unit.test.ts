import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { renderPatterns } from '../render.ts';

it('every pattern part is valid, has the face count and the closed-form volume of its bores', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pat-'));
  try {
    const rows = renderPatterns(dir, 200);
    expect(rows.map((r) => [r.copies, r.faces, r.valid])).toEqual([
      [6, 3 + 6, true],
      [12, 3 + 12, true],
      [12, 6 + 12, true],
      [8, 3 + 8, true],
    ]);
    for (const r of rows) expect(r.volumeError).toBeLessThan(1e-7);
    expect(readFileSync(join(dir, 'pattern-sheet.png')).length).toBeGreaterThan(2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300000);
