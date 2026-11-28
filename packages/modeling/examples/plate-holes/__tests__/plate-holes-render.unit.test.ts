import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { renderPlateHoles } from '../render.ts';

it('renders the E1e chained-hole plate sheet', { timeout: 240_000 }, () => {
  const rows = renderPlateHoles(mkdtempSync(join(tmpdir(), 'plate-holes-')), 300);
  for (const row of rows) {
    if (!row.valid) throw new Error(`${row.name} invalid`);
  }
});
