import {
  resolveVisibility as resolveRenderVisibility,
  Visibility,
  VisibilityStateValue,
  type VisibilityState,
} from '@forgeax/engine-render';
import type { World } from '@forgeax/engine-ecs';
import { firstScoringTarget, type ScoringTargetQuery } from './scoring-target';

export type VisibilityLoopSnapshot = {
  readonly available: boolean;
  readonly intent: VisibilityState;
  readonly effective: 'hidden' | 'visible';
  readonly source: 'default' | 'self' | 'parent';
  readonly toggles: number;
  readonly explicitlyHidden: number;
};

export type VisibilityLoopHandle = {
  readonly toggle: () => void;
  readonly reset: () => void;
  readonly snapshot: () => VisibilityLoopSnapshot;
};

const EMPTY: VisibilityLoopSnapshot = {
  available: false,
  intent: 'inherited',
  effective: 'visible',
  source: 'default',
  toggles: 0,
  explicitlyHidden: 0,
};

/**
 * Compose render author intent with the existing target gameplay owner.
 * Visibility never removes physics, picking, scoring, or Disabled state.
 */
export function installVisibilityLoop(
  world: World,
  targetQuery: ScoringTargetQuery,
): VisibilityLoopHandle {
  const target = firstScoringTarget(world, targetQuery);
  if (target === undefined) {
    return { toggle() {}, reset() {}, snapshot: () => EMPTY };
  }

  const existing = world.get(target, Visibility);
  const initial: VisibilityState = existing.ok
    ? existing.value.state === VisibilityStateValue.hidden
      ? 'hidden'
      : existing.value.state === VisibilityStateValue.visible
        ? 'visible'
        : 'inherited'
    : 'inherited';
  if (!existing.ok) {
    const added = world.addComponent(target, {
      component: Visibility,
      data: { state: VisibilityStateValue.inherited },
    });
    if (!added.ok) return { toggle() {}, reset() {}, snapshot: () => EMPTY };
  }

  let toggles = 0;
  const setState = (state: VisibilityState): void => {
    world.set(target, Visibility, { state: VisibilityStateValue[state] }).unwrap();
  };
  const toggle = (): void => {
    const current = world.get(target, Visibility);
    const intent = current.ok
      ? current.value.state === VisibilityStateValue.hidden
        ? 'hidden'
        : current.value.state === VisibilityStateValue.visible
          ? 'visible'
          : 'inherited'
      : 'inherited';
    setState(intent === 'hidden' ? 'visible' : 'hidden');
    toggles += 1;
  };
  const reset = (): void => {
    setState(initial);
    toggles = 0;
  };

  return {
    toggle,
    reset,
    snapshot: () => {
      const visibility = resolveRenderVisibility(world);
      const resolved = visibility.get(target);
      const effective = visibility.effective(target);
      return {
        available: true,
        intent: resolved?.intent ?? 'inherited',
        effective,
        source: resolved?.source ?? 'default',
        toggles,
        explicitlyHidden: effective === 'hidden' ? 1 : 0,
      };
    },
  };
}
