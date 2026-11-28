import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { RenderFeaturePlanExecution } from './host';
import type { RenderFeaturePlannedFrame } from './plan';

/** Current view commands in plan order, as checked at admission. Atomic indices
 * refer to both arrays and are present only when a plan requires command evidence. */
export interface ViewFeatureWork {
  readonly plans: readonly RenderFeaturePlannedFrame[];
  readonly executions: readonly RenderFeaturePlanExecution[];
  readonly atomic: readonly number[] | undefined;
}

const EMPTY_WORK: readonly never[] = Object.freeze([]);

export const EMPTY_VIEW_FEATURE_WORK: ViewFeatureWork = Object.freeze({
  plans: EMPTY_WORK,
  executions: EMPTY_WORK,
  atomic: undefined,
});

export interface AdmittedViewFeatures {
  readonly work: ViewFeatureWork;
  readonly fullscreenEffects: ReadonlyMap<string, PostProcessShaderEntry>;
  readonly postProcessIdentities: readonly string[];
}

export const EMPTY_ADMITTED_VIEW_FEATURES: AdmittedViewFeatures = Object.freeze({
  work: EMPTY_VIEW_FEATURE_WORK,
  fullscreenEffects: new Map(),
  postProcessIdentities: EMPTY_WORK,
});

export function viewFeaturesOf(frame: RenderFrameState): AdmittedViewFeatures {
  return frame.viewFeatures ?? EMPTY_ADMITTED_VIEW_FEATURES;
}

export function resetViewFeatures(frame: RenderFrameState): void {
  frame.viewFeatures = undefined;
  frame.previousViewFeatures = undefined;
}

/** Restore the complete publication if the candidate's frame did not submit. */
export function settleViewFeatures(frame: RenderFrameState, accepted: boolean): void {
  const previous = frame.previousViewFeatures;
  if (previous === undefined) return;
  frame.previousViewFeatures = undefined;
  if (!accepted) frame.viewFeatures = previous;
}
