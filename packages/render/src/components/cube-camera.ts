// @forgeax/engine-render - CubeCamera capture vocabulary.
//
// CubeCamera is an ECS capture intent paired with Transform. GPU resources,
// face views, completed-receipt promotion, and publication remain renderer-owned.

import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { RenderIntentInvalidError } from '../errors/render';

export const CUBE_CAMERA_UPDATE_ONCE = 0;
export const CUBE_CAMERA_UPDATE_ON_DEMAND = 1;
export const CUBE_CAMERA_UPDATE_CONTINUOUS = 2;

export type CubeCameraUpdateIntent = 'once' | 'on-demand' | 'continuous';

export const CUBE_CAMERA_FACE_ORDER = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;
export type CubeCameraFace = (typeof CUBE_CAMERA_FACE_ORDER)[number];

export function cubeCameraUpdateIntentFromF32(value: number): CubeCameraUpdateIntent {
  switch (value) {
    case CUBE_CAMERA_UPDATE_ONCE:
      return 'once';
    case CUBE_CAMERA_UPDATE_ON_DEMAND:
      return 'on-demand';
    case CUBE_CAMERA_UPDATE_CONTINUOUS:
      return 'continuous';
    default:
      throw new RenderIntentInvalidError('CubeCamera', value);
  }
}

export function cubeCameraUpdateIntentToF32(intent: CubeCameraUpdateIntent): number {
  switch (intent) {
    case 'once':
      return CUBE_CAMERA_UPDATE_ONCE;
    case 'on-demand':
      return CUBE_CAMERA_UPDATE_ON_DEMAND;
    case 'continuous':
      return CUBE_CAMERA_UPDATE_CONTINUOUS;
  }
}

/** ECS declaration for a bounded, transient six-face capture request. */
export const CubeCamera = defineComponent('CubeCamera', {
  target: { type: 'shared<RenderTarget>', simulationTransient: true },
  near: { type: 'f32', default: 0.1 },
  far: { type: 'f32', default: 100 },
  updateIntent: { type: 'f32', default: CUBE_CAMERA_UPDATE_ONCE },
  requestVersion: { type: 'u32', default: 0 },
  faceBudget: { type: 'u32', default: 1 },
});

export type CubeCameraData = ShapeOf<SchemaOf<typeof CubeCamera>>;
