import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBaselines } from '../render-baselines.ts';

describe('baseline contact sheets', () => {
  it('renders a sheet for one case (all cases and a fixed directory with QB_RENDER_OUT)', () => {
    const fixed = process.env.QB_RENDER_OUT;
    const out = fixed ?? mkdtempSync(join(tmpdir(), 'qb-render-'));
    const sheets = renderBaselines(out, fixed === undefined ? 'brep-box-quad' : undefined);
    expect(sheets.length).toBeGreaterThan(0);
    for (const s of sheets) expect(existsSync(s)).toBe(true);
  }, 600_000);
});
