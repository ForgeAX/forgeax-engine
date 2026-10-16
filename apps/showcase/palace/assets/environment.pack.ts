import { definePack } from '@forgeax/engine/pack/source';
import type { EquirectAsset } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { definePackageId } from '@forgeax/engine/pack/source';
const PACKAGE_IDS = { environment: definePackageId('ae95da62-8ad3-47d6-a814-32245a1b7a70') };
const SUN_OUTGOING_DIRECTION = [-0.45,-0.8,-0.32] as const;

const WIDTH = 256;
const HEIGHT = 128;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function floatToHalf(value: number): number {
  const source = new Float32Array([value]);
  const bits = new Uint32Array(source.buffer)[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | (mantissa === 0 ? 0x7c00 : 0x7e00);
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign;
    const hidden = mantissa | 0x800000;
    const shift = 14 - halfExponent;
    return sign | ((hidden + (1 << (shift - 1))) >> shift);
  }
  return sign | (halfExponent << 10) | ((mantissa + 0x1000) >> 13);
}

function writeHalf(data: Uint8Array, offset: number, value: number): void {
  const half = floatToHalf(value);
  data[offset] = half & 0xff;
  data[offset + 1] = half >>> 8;
}

function analyticDaylight(): EquirectAsset {
  const data = new Uint8Array(WIDTH * HEIGHT * 8);
  const outgoingLength = Math.hypot(...SUN_OUTGOING_DIRECTION);
  const sun = SUN_OUTGOING_DIRECTION.map((value) => -value / outgoingLength) as [
    number,
    number,
    number,
  ];
  for (let y = 0; y < HEIGHT; y += 1) {
    const latitude = Math.PI * (0.5 - (y + 0.5) / HEIGHT);
    const cosLatitude = Math.cos(latitude);
    for (let x = 0; x < WIDTH; x += 1) {
      const longitude = Math.PI * (2 * ((x + 0.5) / WIDTH) - 1);
      const direction = [
        cosLatitude * Math.sin(longitude),
        Math.sin(latitude),
        cosLatitude * Math.cos(longitude),
      ] as const;
      const up = clamp(direction[1], 0, 1);
      const horizon = Math.exp(-Math.max(direction[1], 0) * 5.5);
      const belowHorizon = smoothstep(-0.12, 0.02, direction[1]);
      const sunAlignment = clamp(
        direction[0] * sun[0] + direction[1] * sun[1] + direction[2] * sun[2],
        0,
        1,
      );
      // The broad circumsolar term keeps the sky natural without baking a
      // second hard Sun into the IBL. DirectionalLight remains the direct-Sun owner.
      const circumsolar = sunAlignment ** 64 * 1.8 + sunAlignment ** 8 * 0.18;
      const zenith = [0.075, 0.27, 0.82] as const;
      const horizonColor = [0.48, 0.72, 1.05] as const;
      const groundBounce = [0.035, 0.045, 0.04] as const;
      const sky = zenith.map(
        (channel, index) =>
          channel * (0.45 + 0.9 * up) +
          (horizonColor[index] ?? 0) * horizon * 0.75 +
          circumsolar * ([1, 0.72, 0.42][index] ?? 0),
      );
      const rgb = sky.map(
        (channel, index) =>
          (groundBounce[index] ?? 0) * (1 - belowHorizon) + channel * belowHorizon,
      );
      const offset = (y * WIDTH + x) * 8;
      writeHalf(data, offset, rgb[0] ?? 0);
      writeHalf(data, offset + 2, rgb[1] ?? 0);
      writeHalf(data, offset + 4, rgb[2] ?? 0);
      writeHalf(data, offset + 6, 1);
    }
  }
  return {
    kind: 'equirect',
    width: WIDTH,
    height: HEIGHT,
    format: 'rgba16float',
    data,
    colorSpace: 'linear',
  };
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_IDS.environment,
  name: 'Palace / Beijing daylight',
  build: () => ok({ 'environment/daylight': analyticDaylight() }),
});
