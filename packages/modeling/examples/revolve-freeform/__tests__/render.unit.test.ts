import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate } from '../../../src/brep/validate.ts';
import { renderRevolveFreeform } from '../render.ts';
import { bellShape, potShape, vaseShape } from '../shapes.ts';

describe('revolve free-form examples', () => {
  it('builds the vase, bell and pot as valid shapes', () => {
    for (const shape of [vaseShape(), bellShape(), potShape()])
      expect(validate(shape).ok).toBe(true);
  }, 120000);

  it('renders four PNG pictures at 720 px', () => {
    const dir = mkdtempSync(join(tmpdir(), 'revolve-freeform-'));
    try {
      const r = renderRevolveFreeform(dir);
      expect(r.files).toHaveLength(4);
      expect(r.quads).toBeGreaterThan(0);
      for (const f of r.files) {
        const png = readFileSync(f);
        expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
        expect(png.readUInt32BE(16)).toBe(720);
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  }, 240000);
});
