import { defineSystemSet } from '@forgeax/engine-ecs';

export const AnimationPlayback = defineSystemSet({ name: 'animation-playback' });
export const AnimationGraphEvaluation = defineSystemSet({ name: 'animation-graph-evaluation' });
export const SkeletalMotionCapture = defineSystemSet({ name: 'skeletal-motion-capture' });
export const SkeletalMotionPrepare = defineSystemSet({ name: 'skeletal-motion-prepare' });
export const SkeletalMotionCompose = defineSystemSet({ name: 'skeletal-motion-compose' });

export const SkeletalMotionRestore = defineSystemSet({ name: 'skeletal-motion-restore' });
export const SplineIKRestore = defineSystemSet({ name: 'spline-ik-restore' });
export const SplineIKSolve = defineSystemSet({ name: 'spline-ik-solve' });
