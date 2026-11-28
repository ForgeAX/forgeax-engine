import { ok } from '@forgeax/engine-types';
import { rayReferenceFailure } from './scene';

export interface SceneFieldBudget {
  readonly maxInstances: number;
  readonly maxFieldBytes: number;
}

/** Shared by configuration admission and retained scene projection. */
export function validateSceneFieldBudget(budget: SceneFieldBudget) {
  if (
    !Number.isSafeInteger(budget.maxInstances) ||
    budget.maxInstances < 1 ||
    budget.maxInstances > 1024 ||
    !Number.isSafeInteger(budget.maxFieldBytes) ||
    budget.maxFieldBytes < 1
  )
    return rayReferenceFailure(
      'retained field requires explicit 1..1024 instance and positive byte budgets',
      true,
    );
  return ok(undefined);
}
