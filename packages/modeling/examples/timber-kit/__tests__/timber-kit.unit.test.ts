import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderTimberKit } from '../render.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

describe('timber kit pictures', () => {
  it('renders every timber recipe closed and valid, with PNG output', () => {
    const outDir = process.env.TIMBER_KIT_OUT ?? mkdtempSync(join(tmpdir(), 'timber-kit-'));
    const size = Number(process.env.TIMBER_KIT_SIZE ?? 96);
    const { rows, files } = renderTimberKit(outDir, size);

    for (const row of rows) {
      expect(row.closed, row.file).toBe(true);
      expect(row.valid, row.file).toBe(true);
      expect(row.faces, row.file).toBeGreaterThan(0);
    }
    expect(files.length).toBeGreaterThan(rows.length);
    for (const file of files) {
      const bytes = readFileSync(file);
      expect([...bytes.subarray(0, 4)], file).toEqual(PNG_SIGNATURE);
      expect(statSync(file).size, file).toBeGreaterThan(200);
    }
  }, 300000);
});
