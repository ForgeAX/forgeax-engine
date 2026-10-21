import {
  type Component,
  FixedUpdate,
  type ScheduleToken,
  Update,
  type World,
} from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { TransformInterpolation } from '@forgeax/engine-scene';
import { AnimationPlayer } from './animation-player';
import { AnimatedBy, AnimationTargetId, AnimationTargets } from './animation-target';
import { clearPlaybackIntervals } from './playback-interval';
import { clearPropertyBindings } from './property-binding';
import { AnimationRootMotion } from './root-motion';
import { AnimationBindingError } from './solver-errors';
import { registerAdvanceAnimationPlayer } from './systems/advance-animation-player';
import { registerEvaluateAnimationGraph } from './systems/evaluate-animation-graph';
import { clearAnimationEvents } from './timeline';

/** Serializable assembly choice; World remains the sole clock. */
export interface AnimationPlaybackOptions {
  readonly cadence?: 'update' | 'fixed';
}

function playbackSchedule(options: AnimationPlaybackOptions): ScheduleToken {
  if (options.cadence !== undefined && options.cadence !== 'update' && options.cadence !== 'fixed')
    throw new AnimationBindingError('animation-solver-options-invalid', {
      reason: 'animation cadence must be update or fixed',
    });
  return options.cadence === 'fixed' ? FixedUpdate : Update;
}

const ANIMATION_COMPONENTS: readonly Component[] = [
  TransformInterpolation,
  AnimationPlayer,
  AnimationRootMotion,
  AnimatedBy,
  AnimationTargetId,
  AnimationTargets,
];

function registerAnimationComponents(world: World): () => void {
  const leases = ANIMATION_COMPONENTS.map((component) =>
    world.components.register(component).unwrap(),
  );
  return () => {
    clearPropertyBindings(world);
    clearAnimationEvents(world);
    clearPlaybackIntervals(world);
    for (let index = leases.length - 1; index >= 0; index -= 1) leases[index]?.dispose();
  };
}

/** Install animation against the World's native asset owner and schedule. */
export function animationPlugin(options: AnimationPlaybackOptions = {}): Plugin {
  const schedule = playbackSchedule(options);
  return {
    name: 'animation',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => registerAnimationComponents(ctx.world), 'animation/components');
      ctx.effect(
        () => registerEvaluateAnimationGraph(ctx.world, schedule),
        'animation/evaluate-graph',
      );
      ctx.effect(
        () => registerAdvanceAnimationPlayer(ctx.world, schedule),
        'animation/advance-player',
      );
    },
  };
}
