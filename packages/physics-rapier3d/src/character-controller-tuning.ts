import type { CharacterControllerData } from '@forgeax/engine-physics';

const DEG_TO_RAD = Math.PI / 180;

/**
 * Re-apply all KCC setters from the component tuning every call (plan-strategy
 * D-7: full reset, no dirty tracking). Degrees -> radians for the two slope
 * setters; offset / autostep / snap pass through as world units. A zero value
 * for auto-step / snap calls `disable*()` rather than `enable*(0)`.
 */
// biome-ignore lint/suspicious/noExplicitAny: Rapier KinematicCharacterController from dynamic module
export function applyKccTuning(ctrl: any, cc: CharacterControllerData): void {
  ctrl.setMaxSlopeClimbAngle(cc.maxSlopeClimbDeg * DEG_TO_RAD);
  ctrl.setMinSlopeSlideAngle(cc.minSlopeSlideDeg * DEG_TO_RAD);
  ctrl.setSlideEnabled(true);
  ctrl.setApplyImpulsesToDynamicBodies(true);
  if (cc.autoStepMaxHeight === 0) {
    ctrl.disableAutostep();
  } else {
    ctrl.enableAutostep(cc.autoStepMaxHeight, cc.autoStepMinWidth, false); // D-7: includeDynamicBodies=false
  }
  if (cc.snapToGroundDist === 0) {
    ctrl.disableSnapToGround();
  } else {
    ctrl.enableSnapToGround(cc.snapToGroundDist);
  }
}
