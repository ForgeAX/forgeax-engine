import type { PosePath } from '@forgeax/engine-modeling';
import { RECOIL } from './proportions.ts';

/**
 * C-600 fire cycle on the rig joints (j1 yaw, j2 elevation, j3/j4 recoil slides): rest, train 60 degrees,
 * elevate 25 degrees, fire (both barrels recoil 1.5 m in 0.08 of the cycle), run out, return to rest.
 */
export const TRAIN = 60;
export const ELEVATE = 25;

export const FIRE_CYCLE: PosePath = {
  interpolation: 'linear',
  keys: [
    { u: 0, pose: { j1: 0, j2: 0, j3: 0, j4: 0 } },
    { u: 0.25, pose: { j1: TRAIN, j2: 0 } },
    { u: 0.5, pose: { j1: TRAIN, j2: ELEVATE } },
    { u: 0.58, pose: { j1: TRAIN, j2: ELEVATE, j3: RECOIL, j4: RECOIL } },
    { u: 0.8, pose: { j1: TRAIN, j2: ELEVATE, j3: 0, j4: 0 } },
    { u: 1, pose: { j1: 0, j2: 0, j3: 0, j4: 0 } },
  ],
};

/** Named frames of the strip, in cycle order (u on FIRE_CYCLE). */
export const CLIP_FRAMES: readonly { readonly name: string; readonly u: number }[] = [
  { name: 'rest', u: 0 },
  { name: 'train', u: 0.25 },
  { name: 'elevate', u: 0.5 },
  { name: 'fire', u: 0.58 },
  { name: 'run-out', u: 0.72 },
  { name: 'return', u: 0.9 },
];
