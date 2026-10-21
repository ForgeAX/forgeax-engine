import type { RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { CapsuleShadowFallbackReason } from './world-capsules';

/**
 * Detached capsule-shadow facts from one completed frame.
 *
 * `requested` counts renderables carrying `CapsuleShadow`; `admitted` counts
 * those whose directional shadow came from capsules instead of cascades.
 * Every other requested renderable appears once in `fallbacks` under the
 * reason it kept (or never had) its cascade shadow. `capsuleCount` is the
 * number of posed capsules submitted for lighting and `droppedCapsules` those
 * culled past the per-frame buffer budget.
 */
export interface CapsuleShadowInspection {
  readonly requested: number;
  readonly admitted: number;
  readonly capsuleCount: number;
  readonly droppedCapsules: number;
  readonly fallbacks: Readonly<Partial<Record<CapsuleShadowFallbackReason, number>>>;
  readonly tileCount: number;
  readonly tileOverflow: number;
}

export interface CapsuleShadowSubmission {
  readonly capsuleCount: number;
  readonly droppedCapsules: number;
  readonly tileCount: number;
  readonly tileOverflow: number;
}

const NO_SUBMISSION: CapsuleShadowSubmission = {
  capsuleCount: 0,
  droppedCapsules: 0,
  tileCount: 0,
  tileOverflow: 0,
};

/** Geometry stays on the entity; participation is read from this frame's accepted materials. */
export function capsuleShadowParticipates(
  source: RenderableSnapshot,
  materials: MaterialFrame | undefined,
): boolean {
  if (source.shadowCaster === false || source.authorVisible === false) return false;
  const hasPass = (material: RenderableSnapshot['material']) => {
    const accepted = materials?.get(material);
    if (accepted === undefined)
      throw new Error('Capsule shadow requires the accepted material frame');
    return accepted.passes.some((pass) => pass.tags.LightMode === 'ShadowCaster');
  };
  return source.materials.length === 0 ? hasPass(source.material) : source.materials.some(hasPass);
}

/** Project extracted capsule states and the frame's lane decision to inspection. */
export function inspectCapsuleShadow(
  renderables: FrameList<RenderableSnapshot>,
  materials: MaterialFrame | undefined,
  deferred: boolean,
  directionalShadow: boolean,
  submission: CapsuleShadowSubmission = NO_SUBMISSION,
): CapsuleShadowInspection | undefined {
  let requested = 0;
  let admitted = 0;
  const fallbacks: Partial<Record<CapsuleShadowFallbackReason, number>> = {};
  for (const source of renderables) {
    const state = source.capsuleShadow;
    if (state === undefined) continue;
    requested += 1;
    let reason: CapsuleShadowFallbackReason | undefined;
    if (state.status !== 'ready') reason = state.status;
    else if (!capsuleShadowParticipates(source, materials)) reason = 'no-shadow-caster-pass';
    else if (!directionalShadow) reason = 'no-directional-shadow';
    else if (!deferred) reason = 'forward-path';
    if (reason === undefined) admitted += 1;
    else fallbacks[reason] = (fallbacks[reason] ?? 0) + 1;
  }
  if (requested === 0) return undefined;
  return Object.freeze({ requested, admitted, ...submission, fallbacks: Object.freeze(fallbacks) });
}
