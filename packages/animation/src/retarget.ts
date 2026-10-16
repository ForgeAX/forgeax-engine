import type { World } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import { compileRetarget, type SkeletonRetargetOptions } from './retarget-core';
import { solverFailure } from './skeleton-pose';
import { AnimationBindingError, type AnimationError } from './solver-errors';

export interface SkeletonRetargeter {
  retarget(weight?: number): Result<void, AnimationError>;
}

/** Capture both reference poses before playback; map explicit joint pairs rather than names. */
export function createSkeletonRetargeter(
  world: World,
  options: SkeletonRetargetOptions,
): Result<SkeletonRetargeter, AnimationError> {
  try {
    const compiled = compileRetarget(world, options);
    return ok({
      retarget(weight = 1) {
        try {
          if (!Number.isFinite(weight) || weight < 0 || weight > 1)
            throw new AnimationBindingError('animation-solver-options-invalid', { weight });
          compiled.source.read();
          compiled.target.read();
          if (weight === 0) return ok(undefined);
          compiled.transfer(weight);
          compiled.target.write(compiled.targetIndices, options.rootTranslationScale !== undefined);
          return ok(undefined);
        } catch (failure) {
          return err(solverFailure(failure));
        }
      },
    });
  } catch (failure) {
    return err(solverFailure(failure));
  }
}
