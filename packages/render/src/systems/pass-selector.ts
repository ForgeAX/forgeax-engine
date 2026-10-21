// M3 / w19: PassSelector matching logic
// (feat-20260526-material-asset-multipass-renderstate)
//
// Pure-function helpers for matching MaterialPass tags against
// a PassSelector. Plan-strategy D-4: Tags free Record + PassSelector
// Record<string, string[]>. Requirements AC-05.

import type { MaterialPass, PassSelector } from '@forgeax/engine-types';

// Internal Standard graph requests, including their value arrays, have no
// mutable aliases. Only these exact identities bypass raw selector observation.
export const FORWARD_PASS_SELECTOR = Object.freeze({
  LightMode: Object.freeze(['Forward'] as const),
});
/** Separate transmission backs read the opaque backdrop before the front copy. */
export const TRANSMISSION_BACK_PASS_SELECTOR = Object.freeze({
  LightMode: Object.freeze(['TransmissionBack'] as const),
});
export const DEFERRED_PASS_SELECTOR = Object.freeze({
  LightMode: Object.freeze(['Deferred'] as const),
});
export const COLOR_PASS_SELECTOR = Object.freeze({
  LightMode: Object.freeze(['Deferred', 'Forward'] as const),
});
export const SHADOW_CASTER_PASS_SELECTOR = Object.freeze({
  LightMode: Object.freeze(['ShadowCaster'] as const),
});

/**
 * Test whether a pass's tags match a {@link PassSelector}.
 *
 * Matching rule (AC-05): every key in the selector must exist in the pass's
 * `tags` and the pass's tag value must be in the selector's value list for
 * that key. An empty selector matches every pass.
 *
 * @param tags The pass-level tags (free key-value pairs)
 * @param selector The selector to match against
 */
export function matchPass(tags: Record<string, string>, selector: PassSelector): boolean {
  if (selector === FORWARD_PASS_SELECTOR)
    return tags.LightMode === FORWARD_PASS_SELECTOR.LightMode[0];
  if (selector === DEFERRED_PASS_SELECTOR)
    return tags.LightMode === DEFERRED_PASS_SELECTOR.LightMode[0];
  if (selector === SHADOW_CASTER_PASS_SELECTOR)
    return tags.LightMode === SHADOW_CASTER_PASS_SELECTOR.LightMode[0];
  if (selector === COLOR_PASS_SELECTOR) {
    // A tag may itself be an accessor. Observe it exactly once, just as the
    // generic matcher does before testing the selector's allowed values.
    const value = tags.LightMode;
    return value === COLOR_PASS_SELECTOR.LightMode[0] || value === COLOR_PASS_SELECTOR.LightMode[1];
  }
  // Public/custom selectors retain eager getter/throw ordering. In particular,
  // Object.keys plus short-circuit reads is not equivalent to Object.entries.
  for (const [key, allowedValues] of Object.entries(selector)) {
    const passValue = tags[key];
    if (passValue === undefined) return false;
    if ((allowedValues as readonly string[]).length === 0) return false;
    if (!(allowedValues as readonly string[]).includes(passValue)) return false;
  }
  return true;
}

/**
 * Filter passes whose tags match the given {@link PassSelector}.
 *
 * An empty selector matches all passes (returns the input array reference).
 * Otherwise each pass is checked via {@link matchPass}.
 *
 * @param passes The material's pass descriptors
 * @param selector The pass selector
 * @returns Filtered array of matching passes
 */
export function selectPasses(
  passes: readonly MaterialPass[],
  selector: PassSelector,
): readonly MaterialPass[] {
  if (Object.keys(selector).length === 0) return passes;
  return passes.filter((p) =>
    matchPass((p.renderState?.tags as Record<string, string> | undefined) ?? {}, selector),
  );
}
