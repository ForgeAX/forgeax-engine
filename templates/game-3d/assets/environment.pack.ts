import { definePack } from '@forgeax/engine/pack/source';
import type { EquirectAsset } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { PACKAGE_IDS, SUN_OUTGOING_DIRECTION } from './shared/asset-refs.ts';

const WIDTH = 256;
const HEIGHT = 128;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function analyticDaylight(): EquirectAsset {
  const pixels = new Float32Array(WIDTH * HEIGHT * 4);
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
      const offset = (y * WIDTH + x) * 4;
      pixels.set([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, 1], offset);
    }
  }
  return {
    kind: 'equirect',
    width: WIDTH,
    height: HEIGHT,
    format: 'rgba32float',
    data: new Uint8Array(pixels.buffer),
    colorSpace: 'linear',
  };
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_IDS.environment,
  name: 'Game 3D / Environment',
  build: () => ok({ 'environment/daylight': analyticDaylight() }),
});
