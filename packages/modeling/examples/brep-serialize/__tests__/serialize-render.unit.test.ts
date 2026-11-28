import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { renderSerialize } from '../render.ts';

it('a decoded Shape renders byte-for-byte like the original, for every part', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ser-'));
  try {
    const rows = renderSerialize(dir, 200);
    expect(rows.map((r) => r.name)).toEqual(['bracket', 'housing', 'filleted box', 'pipe elbow']);
    for (const r of rows) {
      expect([r.name, r.pixelDifferences]).toEqual([r.name, 0]);
      expect(r.faces).toBeGreaterThan(5);
      expect(Math.abs(r.volume)).toBeGreaterThan(1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
