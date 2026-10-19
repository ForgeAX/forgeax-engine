import { halfFloat } from '@forgeax/engine-math';
import { IES_PROFILE_HEIGHT, IES_PROFILE_WIDTH, type IesProfileAsset } from '@forgeax/engine-types';
import type { Lm63TypeC } from './parse-lm63.js';

function interpolateHorizontal(source: Lm63TypeC, angle: number, verticalIndex: number): number {
  const angles = source.horizontalAnglesDeg;
  const values = source.candela;
  const verticalCount = source.verticalAnglesDeg.length;
  const lastAngle = angles.at(-1) ?? 0;
  if (angles.length === 1) return values[verticalIndex] ?? 0;

  // Fold the lookup into the measured photometric planes without copying rows.
  if (angles[0] === 90) {
    if (angle < 90) angle = 180 - angle;
    else if (angle > 270) angle = 540 - angle;
  } else if (lastAngle < 360) {
    angle %= 2 * lastAngle;
    if (angle > lastAngle) angle = 2 * lastAngle - angle;
  }
  let lower = 0;
  while (lower + 1 < angles.length && (angles[lower + 1] ?? 0) < angle) lower++;
  const upper = Math.min(lower + 1, angles.length - 1);
  const left = angles[lower] ?? 0;
  const right = angles[upper] ?? 0;
  const factor = right === left ? 0 : (angle - left) / (right - left);
  const a = values[lower * verticalCount + verticalIndex] ?? 0;
  const b = values[upper * verticalCount + verticalIndex] ?? 0;
  return a + (b - a) * factor;
}

export function readFloat16LE(bytes: Uint8Array, offset: number): number {
  const bits = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
  return halfFloat.f16ToF32(bits);
}

export function resampleTypeC(source: Lm63TypeC): Uint8Array {
  const verticalCount = source.verticalAnglesDeg.length;
  const output = new Uint8Array(IES_PROFILE_WIDTH * IES_PROFILE_HEIGHT * 2);
  let peak = 0;
  const samples: number[] = [];
  for (let y = 0; y < IES_PROFILE_HEIGHT; y++) {
    const vertical = (y / (IES_PROFILE_HEIGHT - 1)) * 180;
    const measured =
      vertical >= (source.verticalAnglesDeg[0] ?? 0) &&
      vertical <= (source.verticalAnglesDeg.at(-1) ?? 180);
    let lower = 0;
    while (lower + 1 < verticalCount && (source.verticalAnglesDeg[lower + 1] ?? 0) < vertical)
      lower++;
    const upper = Math.min(lower + 1, verticalCount - 1);
    const left = source.verticalAnglesDeg[lower] ?? 0;
    const right = source.verticalAnglesDeg[upper] ?? 0;
    const factor = right === left ? 0 : (vertical - left) / (right - left);
    for (let x = 0; x < IES_PROFILE_WIDTH; x++) {
      const horizontal = (x / IES_PROFILE_WIDTH) * 360;
      const low = interpolateHorizontal(source, horizontal, lower);
      const high = interpolateHorizontal(source, horizontal, upper);
      const value = measured ? low + (high - low) * factor : 0;
      samples.push(Math.max(0, value));
      peak = Math.max(peak, value);
    }
  }
  const divisor = peak > 0 ? peak : 1;
  for (let index = 0; index < samples.length; index++) {
    const bits = halfFloat.f32ToF16((samples[index] ?? 0) / divisor);
    output[index * 2] = bits & 0xff;
    output[index * 2 + 1] = bits >>> 8;
  }
  return output satisfies IesProfileAsset['data'];
}
