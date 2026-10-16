import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { ENTITY_NULL_RAW } from '@forgeax/engine-ecs';
import { expectTypeOf } from 'vitest';
import type { BindAnimationTargetsErrorCode } from '../index';
import {
  AnimatedBy,
  AnimationPlayer,
  AnimationTargetId,
  AnimationTargets,
  bindAnimationTargets,
  defineAnimationGraph,
  deriveAnimationTargetId,
  isAnimationTargetId,
} from '../index';

expectTypeOf(deriveAnimationTargetId).parameter(0).toEqualTypeOf<readonly string[]>();
expectTypeOf(isAnimationTargetId).returns.toEqualTypeOf<boolean>();
expectTypeOf(AnimationTargetId).toBeObject();
expectTypeOf(AnimatedBy).toBeObject();
expectTypeOf(AnimationTargets).toBeObject();
expectTypeOf(AnimationPlayer).toBeObject();
expectTypeOf(defineAnimationGraph).toBeFunction();
expectTypeOf<BindAnimationTargetsErrorCode>().toEqualTypeOf<
  | 'animation-target-player-invalid'
  | 'animation-target-invalid'
  | 'animation-target-outside-player-root'
  | 'animation-target-name-missing'
  | 'animation-target-id-invalid'
  | 'animation-target-id-duplicate'
  | 'animation-target-player-conflict'
  | 'animation-target-capacity-reserve-failed'
  | 'animation-target-bind-failed'
>();

function collectAndBind(
  world: World,
  player: EntityHandle,
  scene: { readonly mapping: ArrayLike<number> },
): ReturnType<typeof bindAnimationTargets> {
  const targets = Array.from(scene.mapping)
    .filter((raw) => raw !== ENTITY_NULL_RAW)
    .map((raw) => raw as EntityHandle)
    .filter((entity) => world.get(entity, AnimationTargetId).ok);
  return bindAnimationTargets(world, player, targets);
}

expectTypeOf(collectAndBind).returns.toEqualTypeOf<ReturnType<typeof bindAnimationTargets>>();
