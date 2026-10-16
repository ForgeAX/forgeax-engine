import { decodeTileBits, encodeTileBits } from '@forgeax/engine/graphics-extras';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Tile flip/rotation bits',
  catalog: 'Tile flip/rotation bits',
  kind: 'headless',
  summary:
    'encodeTileBits/decodeTileBits pack a Tiled-compatible u32: bit 31 flipH, 30 flipV, 29 flipDiagonal, 28 flipHex120, low 28 bits the 1-based tile id (0 = empty). No Renderer or World involved.',
  expect:
    'Every check passes: exact bit positions, a full round-trip over all 16 flag combinations, and a RangeError for out-of-range ids.',
  run(checks) {
    checks.equal(
      'plain id keeps high bits clear',
      encodeTileBits(7, false, false, false, false),
      7,
    );
    checks.equal(
      'flipH is bit 31',
      encodeTileBits(1, true, false, false, false) >>> 0,
      (0x80000000 | 1) >>> 0,
    );
    checks.equal('flipV is bit 30', encodeTileBits(1, false, true, false, false) >>> 0, 0x40000001);
    checks.equal(
      'flipDiagonal is bit 29',
      encodeTileBits(1, false, false, true, false) >>> 0,
      0x20000001,
    );
    checks.equal(
      'flipHex120 is bit 28',
      encodeTileBits(1, false, false, false, true) >>> 0,
      0x10000001,
    );
    checks.equal('decode of a raw Tiled cell', decodeTileBits(0xa0000005), {
      tileId: 5,
      flipH: true,
      flipV: false,
      flipDiagonal: true,
      flipHex120: false,
    });
    let roundTrips = 0;
    for (let mask = 0; mask < 16; mask++) {
      const flags = [
        (mask & 1) !== 0,
        (mask & 2) !== 0,
        (mask & 4) !== 0,
        (mask & 8) !== 0,
      ] as const;
      const decoded = decodeTileBits(encodeTileBits(0x0fffffff, ...flags));
      if (
        decoded.tileId === 0x0fffffff &&
        decoded.flipH === flags[0] &&
        decoded.flipV === flags[1] &&
        decoded.flipDiagonal === flags[2] &&
        decoded.flipHex120 === flags[3]
      ) {
        roundTrips++;
      }
    }
    checks.equal('16 flag combinations round-trip at max id', roundTrips, 16);
    checks.equal(
      'id 0 stays the empty sentinel',
      decodeTileBits(encodeTileBits(0, false, false, false, false)).tileId,
      0,
    );
    for (const bad of [-1, 0x10000000, 1.5]) {
      let error: unknown;
      try {
        encodeTileBits(bad, false, false, false, false);
      } catch (caught) {
        error = caught;
      }
      checks.ok(
        `id ${bad} is rejected with RangeError`,
        error instanceof RangeError,
        String(error),
      );
    }
  },
});
