import { PhysicsError } from './errors.js';

/** Startup configuration shared by the 2D and 3D physics plugins. */
export interface PhysicsOptions {
  /** Global solver iterations per fixed step. Integer [1,32]; defaults to 4. */
  readonly solverIterations?: number;
}

/** Validate before allocating a native World; never silently clamp authored precision. */
export function validateSolverIterations(value = 4): number {
  if (!Number.isInteger(value) || value < 1 || value > 32)
    throw new PhysicsError({
      code: 'invalid-body-config',
      expected: 'solverIterations is an integer in [1,32]',
      hint: 'set physics plugin solverIterations to an integer in [1,32], or omit it for 4',
      detail: { code: 'invalid-body-config', field: 'solverIterations', value },
    });
  return value;
}
