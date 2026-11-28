import { degrees, referenceCamera } from '../terrain.ts';

export const NUBIS_MODES = ['nubis-dawn', 'nubis-sunlit', 'nubis-boss'] as const;
export type NubisMode = typeof NUBIS_MODES[number];

export function isNubisMode(mode: unknown): mode is NubisMode {
  return NUBIS_MODES.some(candidate => candidate === mode);
}

export const NUBIS_LAYER = { bottomMeters: 1000, thicknessMeters: 9000 } as const;
export const NUBIS_LAYOUT_METERS = 80_000;
export const NUBIS_PLANET_RADIUS = 6_360_000;

const camera = referenceCamera();
const azimuth = 180 - camera.yaw / degrees;
export const NUBIS_SUNLIT_SUN = { sunElevation: 29, sunAzimuth: azimuth + 5 } as const;
export const NUBIS_BOSS_SUN = { sunElevation: 23, sunAzimuth: azimuth } as const;
