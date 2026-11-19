import { PhysicsError } from './errors.js';

/** Startup configuration shared by the 2D and 3D physics plugins. */
export interface PhysicsOptions {
  /** Global solver iterations per fixed step. Integer [1,32]; defaults to 4. */
  readonly solverIterations?: number;
  /** Apply the default two-step results look-behind on async solver backends. Defaults to true. */
  readonly asyncResultsInterpolation?: boolean;
  /** Permit Rapier native step timing leases; the native profiler is enabled only while a lease exists. Defaults to false. */
  readonly profileNativeStepTimings?: boolean;
}

export function validateAsyncResultsInterpolation(value = true): boolean {
  if (typeof value !== 'boolean')
    throw new PhysicsError({
      code: 'invalid-body-config',
      expected: 'asyncResultsInterpolation is a boolean',
      hint: 'set the physics results interpolation policy to true or false',
      detail: { code: 'invalid-body-config', field: 'asyncResultsInterpolation', value },
    });
  return value;
}

export function validateProfileNativeStepTimings(value = false): boolean {
  if (typeof value !== 'boolean')
    throw new PhysicsError({
      code: 'invalid-body-config',
      expected: 'profileNativeStepTimings is a boolean',
      hint: 'set profileNativeStepTimings to true or false',
      detail: { code: 'invalid-body-config', field: 'profileNativeStepTimings', value },
    });
  return value;
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
