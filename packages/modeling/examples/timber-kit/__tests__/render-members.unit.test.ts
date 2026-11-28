import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bracketDous, bracketMembers } from '../../../src/recipes/dougong.ts';
import {
  dougongParts,
  explodeShiftOf,
  renderTimberMembers,
  tierOfKeys,
  zExtentOf,
} from '../render-members.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

describe('timber member pictures', () => {
  it('renders the dou, arm, dougong and joint members closed and valid, with PNG output', () => {
    const outDir = process.env.TIMBER_MEMBERS_OUT ?? mkdtempSync(join(tmpdir(), 'timber-members-'));
    const size = Number(process.env.TIMBER_MEMBERS_SIZE ?? 96);
    const { rows, files, coverage } = renderTimberMembers(outDir, size);

    // Bracket sets are flat; their isometric views must still fill most of the frame.
    for (const name of ['dougong-4-iso.png', 'dougong-5-iso.png']) {
      const c = coverage.find((item) => item.file === name);
      expect(c, name).toBeDefined();
      expect(Math.max(c?.width ?? 0, c?.height ?? 0), name).toBeGreaterThanOrEqual(0.7);
    }
    // Front and side views are written for inspection; only their presence is asserted here.
    for (const name of ['dougong-4.png', 'dougong-4-side.png', 'dougong-5-front.png']) {
      expect(
        coverage.find((item) => item.file === name),
        name,
      ).toBeDefined();
    }

    for (const row of rows) {
      expect(row.closed, row.key).toBe(true);
      expect(row.valid, row.key).toBe(true);
      expect(row.confirmedCrossings, row.key).toBe(0);
      expect(row.faces, row.key).toBeGreaterThan(0);
    }
    expect(files.length).toBeGreaterThan(rows.length);
    for (const file of files.filter((f) => f.endsWith('.png'))) {
      const bytes = readFileSync(file);
      expect([...bytes.subarray(0, 4)], file).toEqual(PNG_SIGNATURE);
      expect(statSync(file).size, file).toBeGreaterThan(200);
    }
    const listing = files.find((f) => f.endsWith('dougong-5-load-path.txt'));
    expect(listing, 'load-path listing written').toBeDefined();
    // Header, then one row per member (10 for puzuo 5) and one row per dou (22 for puzuo 5).
    expect(
      readFileSync(listing as string, 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1 + 10 + 22);
  }, 300000);

  it('explodes the five-puzuo set by tier to at least 1.8 times its assembled height, dropping no face', () => {
    const assembled = dougongParts(5);
    const exploded = dougongParts(5, true);
    expect(zExtentOf(exploded.pieces)).toBeGreaterThanOrEqual(1.8 * zExtentOf(assembled.pieces));
    const faces = (pieces: readonly { poly: { faces: readonly unknown[] } }[]) =>
      pieces.reduce((n, p) => n + p.poly.faces.length, 0);
    expect(faces(exploded.pieces)).toBe(faces(assembled.pieces));
  }, 300000);

  it.each([4, 5] as const)(
    'puzuo %i exploded: every dou takes the lift of the tier of the member it sits on',
    (puzuo) => {
      const tiers = tierOfKeys(puzuo);
      const dous = bracketDous(puzuo, bracketMembers(puzuo));
      expect(dous.length).toBeGreaterThan(0);
      for (const d of dous) {
        // Dou tier is its seat member's tier, so the rigid tier group lifts it with that member.
        const seat = d.sitsOn === null ? 0 : tiers.get(d.sitsOn);
        expect(seat, d.key).toBeDefined();
        expect(d.tier, d.key).toBe(seat);
        expect(tiers.get(d.key), d.key).toBe(d.tier);
      }
      expect(explodeShiftOf(1)).toBeGreaterThan(0);
      expect(explodeShiftOf(2)).toBeCloseTo(2 * explodeShiftOf(1), 12);
    },
  );
});
