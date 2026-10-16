// tile-bits.test - encodeTileBits / decodeTileBits round-trip + boundary tests
// (feat-20260608 M0 baseline rebuild).
//
// Tile id encoding (Tiled .tmj wire format compatibility, feat-20260604 D-2):
//   - low 28 bits: tileId (0..0x0FFFFFFF).
//   - high 4 bits, MSB -> LSB: flipHorizontal, flipVertical, flipDiagonal,
//     flipHex120 (the latter is the Tiled hex 120deg flip slot; preserved for
//     wire fidelity even though M0 does not consume it).
//   - tileId === 0 means "empty cell" downstream in TileLayer.tiles (sentinel).
//
// Anchors: requirements integration points (engine-runtime); plan-tasks m0-t3.

import { describe, expect, it } from 'vitest';
import { decodeTileBits, encodeTileBits } from '../tile-bits';

const FLIP_VARIANTS: ReadonlyArray<readonly [boolean, boolean, boolean, boolean]> = [
  [false, false, false, false],
  [true, false, false, false],
  [false, true, false, false],
  [false, false, true, false],
  [false, false, false, true],
  [true, true, false, false],
  [true, false, true, false],
  [true, true, true, true],
];

const TILE_ID_BOUNDARIES: readonly number[] = [0, 1, 0x0fffffff - 1, 0x0fffffff];

describe('encodeTileBits / decodeTileBits round-trip (M0 baseline)', () => {
  for (const tileId of TILE_ID_BOUNDARIES) {
    for (const [flipH, flipV, flipDiagonal, flipHex120] of FLIP_VARIANTS) {
      it(`tileId=${tileId} flipH=${flipH} flipV=${flipV} flipD=${flipDiagonal} flipHex120=${flipHex120}`, () => {
        const packed = encodeTileBits(tileId, flipH, flipV, flipDiagonal, flipHex120);
        const decoded = decodeTileBits(packed);
        expect(decoded.tileId).toBe(tileId);
        expect(decoded.flipH).toBe(flipH);
        expect(decoded.flipV).toBe(flipV);
        expect(decoded.flipDiagonal).toBe(flipDiagonal);
        expect(decoded.flipHex120).toBe(flipHex120);
      });
    }
  }
});

describe('encodeTileBits — high-bit wire layout (MSB H / V / D / Hex120)', () => {
  it('flipH sets bit 31 (MSB)', () => {
    const packed = encodeTileBits(0, true, false, false, false);
    expect(packed >>> 31).toBe(1);
    expect((packed >>> 30) & 0x1).toBe(0);
  });

  it('flipV sets bit 30', () => {
    const packed = encodeTileBits(0, false, true, false, false);
    expect((packed >>> 31) & 0x1).toBe(0);
    expect((packed >>> 30) & 0x1).toBe(1);
    expect((packed >>> 29) & 0x1).toBe(0);
  });

  it('flipDiagonal sets bit 29', () => {
    const packed = encodeTileBits(0, false, false, true, false);
    expect((packed >>> 29) & 0x1).toBe(1);
    expect((packed >>> 28) & 0x1).toBe(0);
  });

  it('flipHex120 sets bit 28', () => {
    const packed = encodeTileBits(0, false, false, false, true);
    expect((packed >>> 28) & 0x1).toBe(1);
  });

  it('tileId fits in the low 28 bits', () => {
    const packed = encodeTileBits(0x0fffffff, false, false, false, false);
    expect(packed >>> 0).toBe(0x0fffffff);
  });
});

describe('encodeTileBits — overflow RangeError (charter P3)', () => {
  it('tileId === 0x10000000 throws RangeError', () => {
    expect(() => encodeTileBits(0x10000000, false, false, false, false)).toThrow(RangeError);
  });

  it('tileId < 0 throws RangeError', () => {
    expect(() => encodeTileBits(-1, false, false, false, false)).toThrow(RangeError);
  });

  it('non-integer tileId throws RangeError', () => {
    expect(() => encodeTileBits(1.5, false, false, false, false)).toThrow(RangeError);
  });
});
