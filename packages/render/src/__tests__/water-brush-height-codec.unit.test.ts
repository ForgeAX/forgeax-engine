import { expect, it } from 'vitest';
import {
  packWaterBrushHeight,
  unpackWaterBrushHeight,
  waterBrushMetersToHeightInt,
  waterBrushWorldPointToTerrainLocal,
} from '../water-brush/height-codec';

it('packs the signed Landscape endpoints in high-byte then low-byte order', () => {
  expect(packWaterBrushHeight(-32768)).toMatchObject({
    heightInt: -32768,
    packedU16: 0,
    red: 0,
    green: 0,
  });
  expect(packWaterBrushHeight(-32767)).toMatchObject({ packedU16: 1, red: 0, green: 1 / 255 });
  expect(packWaterBrushHeight(0)).toMatchObject({ packedU16: 32768, red: 128 / 255, green: 0 });
  expect(packWaterBrushHeight(32766)).toMatchObject({ packedU16: 65534, red: 1, green: 254 / 255 });
  expect(packWaterBrushHeight(32767)).toMatchObject({
    heightInt: 32767,
    packedU16: 65535,
    red: 1,
    green: 1,
  });
  expect(packWaterBrushHeight(32768).heightInt).toBe(32767);
  expect(packWaterBrushHeight(-32769).heightInt).toBe(-32768);
});

it('keeps the graph Unpack +1 distinct from Pack and converts local metres at 128 height units per centimeter', () => {
  expect(waterBrushMetersToHeightInt(0)).toBe(0);
  expect(waterBrushMetersToHeightInt(1)).toBe(12800);
  expect(waterBrushMetersToHeightInt(-1)).toBe(-12800);
  expect(waterBrushMetersToHeightInt(0.5 / 12800)).toBe(1);
  expect(waterBrushMetersToHeightInt(-0.5 / 12800)).toBe(-1);
  expect(packWaterBrushHeight(1.9)).toMatchObject({ heightInt: 1, packedU16: 32769 });
  expect(packWaterBrushHeight(-1.9)).toMatchObject({ heightInt: -1, packedU16: 32767 });
  expect(packWaterBrushHeight(32767.9).heightInt).toBe(32767);
  expect(packWaterBrushHeight(-32768.9).heightInt).toBe(-32768);
  const packedZero = packWaterBrushHeight(0);
  expect(unpackWaterBrushHeight(packedZero.red, packedZero.green)).toEqual({
    heightInt: 1,
    heightM: 1 / 12800,
  });
  expect(unpackWaterBrushHeight(1, 1)).toEqual({ heightInt: 32768, heightM: 32768 / 12800 });
});

it('maps world capture points back through translated, rotated and nonuniform frozen Terrain transforms', () => {
  const matrix = [0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 10, -5, 7, 1];
  const local = [2, 1.25, -3] as const;
  const world = [10 + -3 * local[1], -5 + 2 * local[0], 7 + 4 * local[2]] as const;
  expect(
    waterBrushWorldPointToTerrainLocal(matrix, world).map((value) => Math.round(value * 1e6) / 1e6),
  ).toEqual(local);
});

it('rejects non-finite height data and singular Terrain transforms', () => {
  expect(() => waterBrushMetersToHeightInt(Number.NaN)).toThrow(/finite/);
  expect(() => packWaterBrushHeight(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  expect(() => unpackWaterBrushHeight(1.01, 0)).toThrow(/normalized/);
  expect(() => waterBrushWorldPointToTerrainLocal(new Array(16).fill(0), [0, 0, 0])).toThrow(
    /invertible/,
  );
});
