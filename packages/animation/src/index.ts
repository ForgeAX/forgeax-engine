/**
 * Animation graphs, players, and stable Transform targets.
 *
 * AI consumers should collect explicit entities, call
 * {@link bindAnimationTargets} once, then configure the existing
 * {@link AnimationPlayer} directly or through {@link defineAnimationGraph}.
 * Binding failures expose stable `code`, `hint`, and `detail` fields.
 *
 * @see ../README.md
 */

export type {
  AnimationMask,
  AnimationTimelineAction,
  AnimationTimelineKey,
} from '@forgeax/engine-types';
export type {
  AnimationDiagnostic,
  AnimationDiagnosticCode,
  AnimationDiagnosticDetail,
  AnimationDiagnosticListener,
} from './animation-diagnostic';
export { subscribeAnimationDiagnostics } from './animation-diagnostic';
export { defineAnimationMask } from './animation-mask';
export { AnimationPlayer } from './animation-player';
/** Stable target identity, explicit ownership, and atomic batch binding. */
export {
  AnimatedBy,
  AnimationTargetId,
  AnimationTargets,
  type BindAnimationTargetsErrorCode,
  bindAnimationTargets,
} from './animation-target';
export { animationClipContribution, animationGraphContribution } from './assets/animation-decoder';
export {
  AnimationBlendError,
  type AnimationBlendErrorCode,
  type AnimationBlendFailure,
} from './blend-errors';
export {
  type BlendSpace1D,
  type BlendSpace2D,
  type BlendSpace2DOptions,
  createBlendSpace1D,
  createBlendSpace2D,
} from './blend-space';
/** Build the existing graph-to-player slot path; this is not an animation FSM. */
export {
  type AnimationGraphNodeRef,
  animationGraphNodeChildren,
  defineAnimationGraph,
} from './graph/define-animation-graph';
export { describeAnimationGraph } from './graph/describe-animation-graph';
export { serializeAnimationGraph } from './graph/serialize-animation-graph';
export { createIKSolver, type IKOptions, type IKResult, type IKSolver } from './ik';
export type { IKJointLimit } from './ik-limits';
export {
  AnimationPlaybackError,
  type AnimationPlaybackErrorCode,
  type AnimationPlaybackFailure,
} from './playback-errors';
export type { AnimationPlaybackOptions } from './plugin';
export { animationPlugin } from './plugin';
export { bindComponentProperty, bindObjectProperty } from './property-binding';
export {
  AnimationAssetError,
  type AnimationAssetErrorCode,
  type AnimationAssetErrorDetail,
  resolveAnimationAsset,
} from './resolve-animation-asset';
export { createSkeletonRetargeter, type SkeletonRetargeter } from './retarget';
export { retargetAnimationClip } from './retarget-clip';
export type { SkeletonRetargetOptions } from './retarget-core';
export { AnimationRootMotion } from './root-motion';
export {
  AnimationBindingError,
  type AnimationBindingErrorCode,
  type AnimationError,
} from './solver-errors';
export {
  _resetAnimationWarnsForTests,
  ADVANCE_ANIMATION_PLAYER_SYSTEM,
  AdvanceAnimationPlayer,
  AnimationSet,
  advanceAnimationPlayer,
  registerAdvanceAnimationPlayer,
} from './systems/advance-animation-player';
export {
  EvaluateAnimationGraph,
  evaluateAnimationGraph,
} from './systems/evaluate-animation-graph';
/** Derive or validate the canonical 32-lowercase-hex animation target wire. */
export { deriveAnimationTargetId, isAnimationTargetId } from './target-id';
export { type AnimationTimelineEvent, drainAnimationEvents } from './timeline';
