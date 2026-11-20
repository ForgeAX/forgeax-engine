import type { Handle, Result } from '@forgeax/engine-types';
import { err } from '@forgeax/engine-types';
import { worldPoisonedError } from './errors';
import type { EcsError, World } from './world';
import { worldInternal } from './world-internal';

/**
 * Producer-only cancellation after an allocation was never adopted by a component.
 * The caller proves no successful component write owns the handle; a read borrow
 * never grants this capability. Ordinary adopted release remains component-owned.
 */
export function releaseUnadoptedUniqueRef(
  world: World,
  handle: Handle<string, 'unique'>,
): Result<void, EcsError> {
  const poisoned = worldPoisonedError(world.execution);
  return poisoned === undefined
    ? world[worldInternal].releaseUnadoptedUniqueRef(handle)
    : err(poisoned);
}
