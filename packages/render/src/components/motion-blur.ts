import { defineComponent } from '@forgeax/engine-ecs';

/** Active-camera motion blur authoring data; presence enables the feature. */
export const MotionBlur = defineComponent('MotionBlur', {
  shutterAngle: { type: 'f32', default: 180 },
  maxRadiusPixels: { type: 'f32', default: 32 },
  sampleCount: { type: 'f32', default: 8 },
  targetFps: { type: 'f32', default: 60 },
});
