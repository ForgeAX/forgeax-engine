import type { World } from '@forgeax/engine-ecs';
import { type AnimationMask, err, ok, type Result, toShared } from '@forgeax/engine-types';
import { AnimationBlendError } from './blend-errors';
import { isAnimationTargetId } from './target-id';

export interface CompiledAnimationMask {
  readonly defaultWeight: number;
  readonly weights: ReadonlyMap<string, number>;
}

type MaskError = AnimationBlendError<'animation-mask-invalid'>;
const compiledMasks = new WeakMap<AnimationMask, CompiledAnimationMask>();
const invalid = (reason: string, index?: number) =>
  err(
    new AnimationBlendError('animation-mask-invalid', {
      reason,
      ...(index === undefined ? {} : { index }),
    }),
  );

function compile(mask: AnimationMask): Result<CompiledAnimationMask, MaskError> {
  if (mask === null || typeof mask !== 'object')
    return invalid('provide an AnimationMask definition');
  const cached = compiledMasks.get(mask);
  if (cached !== undefined) return ok(cached);
  if (!Number.isFinite(mask.defaultWeight) || mask.defaultWeight < 0 || mask.defaultWeight > 1)
    return invalid('defaultWeight must be finite and within [0, 1]');
  if (!Array.isArray(mask.targets) || mask.targets.length > 4096)
    return invalid('targets must be an array with at most 4096 entries');
  const weights = new Map<string, number>();
  for (let i = 0; i < mask.targets.length; i++) {
    const target = mask.targets[i];
    if (target === null || typeof target !== 'object' || !isAnimationTargetId(target.targetId))
      return invalid('each entry must name a canonical AnimationTargetId', i);
    if (!Number.isFinite(target.weight) || target.weight < 0 || target.weight > 1)
      return invalid('target weights must be finite and within [0, 1]', i);
    if (weights.has(target.targetId)) return invalid('each target must appear once', i);
    weights.set(target.targetId, target.weight);
  }
  const compiled = { defaultWeight: mask.defaultWeight, weights };
  compiledMasks.set(mask, compiled);
  return ok(compiled);
}

/** Snapshot reusable mask data. Unlisted targets default to zero unless specified. */
export function defineAnimationMask(
  targets: AnimationMask['targets'],
  defaultWeight = 0,
): Result<AnimationMask, MaskError> {
  const checked = compile({ targets, defaultWeight });
  if (!checked.ok) return checked;
  const definition = Object.freeze({
    defaultWeight,
    targets: Object.freeze(targets.map((target) => Object.freeze({ ...target }))),
  });
  compiledMasks.set(definition, checked.value);
  return ok(definition);
}

/** Resolve through the World every use; cached compilation never hides a retired handle. */
export function resolveAnimationMask(
  world: World,
  handle: number,
): CompiledAnimationMask | undefined {
  if (handle === 0) return undefined;
  const resolved = world.sharedRefs.resolve<'AnimationMask', AnimationMask>(
    toShared<'AnimationMask'>(handle),
  );
  if (!resolved.ok) throw resolved.error;
  const compiled = compile(resolved.value);
  if (!compiled.ok) throw compiled.error;
  return compiled.value;
}

export function animationMaskWeight(mask: CompiledAnimationMask, targetId: string): number {
  return mask.weights.get(targetId) ?? mask.defaultWeight;
}
