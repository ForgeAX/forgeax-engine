import { mat4, vec3 } from '@forgeax/engine-math';
import { requireWaterValue } from '@forgeax/engine-water/internal';

const LOCAL_HEIGHT_UNITS_PER_METER = 100 * 128;
const HEIGHT_INT_MIN = -32768;
const HEIGHT_INT_MAX = 32767;

export type WaterBrushPackedHeight = Readonly<{
  heightInt: number;
  packedU16: number;
  red: number;
  green: number;
}>;

function finite(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`Water Brush ${field} must be finite`);
}

function roundAwayFromZero(value: number): number {
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
}

/** Quantize TerrainSource local metres to the signed Landscape height-int domain, rounding ties away from zero. */
export function waterBrushMetersToHeightInt(heightM: number): number {
  finite(heightM, 'height');
  return Math.max(
    HEIGHT_INT_MIN,
    Math.min(HEIGHT_INT_MAX, roundAwayFromZero(heightM * LOCAL_HEIGHT_UNITS_PER_METER)),
  );
}

/** Match PackRG8Height's float clamp, Custom-node integer truncation, bias, and byte order. */
export function packWaterBrushHeight(heightValue: number): WaterBrushPackedHeight {
  finite(heightValue, 'height');
  const clamped = Math.trunc(Math.max(HEIGHT_INT_MIN, Math.min(HEIGHT_INT_MAX, heightValue)));
  const packedU16 = clamped + 32768;
  return Object.freeze({
    heightInt: clamped,
    packedU16,
    red: (packedU16 >>> 8) / 255,
    green: (packedU16 & 0xff) / 255,
  });
}

/** Match UnpackRG8Height's byte rounding and its audited +1 graph node. */
export function unpackWaterBrushHeight(
  red: number,
  green: number,
): Readonly<{ heightInt: number; heightM: number }> {
  finite(red, 'packed red channel');
  finite(green, 'packed green channel');
  if (red < 0 || red > 1 || green < 0 || green > 1)
    throw new RangeError('Water Brush packed height channels must be normalized to [0, 1]');
  const packedU16 = Math.max(
    0,
    Math.min(65536, (Math.floor(red * 255 + 0.5) << 8) | Math.floor(green * 255 + 0.5)),
  );
  const heightInt = packedU16 - 32767;
  return Object.freeze({ heightInt, heightM: heightInt / LOCAL_HEIGHT_UNITS_PER_METER });
}

/** Convert a captured world point through the frozen Terrain local-to-world transform. */
export function waterBrushWorldPointToTerrainLocal(
  worldMatrixM: readonly number[],
  worldPointM: readonly [number, number, number],
): readonly [number, number, number] {
  if (worldMatrixM.length !== 16 || worldMatrixM.some((value) => !Number.isFinite(value)))
    throw new RangeError('Water Brush Terrain transform must contain 16 finite matrix values');
  if (worldPointM.some((value) => !Number.isFinite(value)))
    throw new RangeError('Water Brush captured world point must be finite');
  const inverse = mat4.invert(mat4.create(), worldMatrixM);
  if (
    !inverse.every(Number.isFinite) ||
    !mat4.equals(
      mat4.multiply(mat4.create(), worldMatrixM, inverse),
      mat4.identity(mat4.create()),
      1e-5,
    )
  ) {
    throw new RangeError('Water Brush Terrain transform must be invertible');
  }
  const point = mat4.transformPoint(vec3.create(), inverse, worldPointM);
  if (point.some((value) => !Number.isFinite(value)))
    throw new RangeError('Water Brush inverse Terrain transform produced a non-finite point');
  return Object.freeze([
    requireWaterValue(point[0]),
    requireWaterValue(point[1]),
    requireWaterValue(point[2]),
  ] as const);
}
