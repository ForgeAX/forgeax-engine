import type { World } from '@forgeax/engine-ecs';
import { PhysicsWorldResource } from '@forgeax/engine-physics';
import type { DynamicGeometryError } from '../dynamic-geometry';
import { RendererContractFailureError, RendererOperationError } from '../errors/render';

/**
 * Paired render and collision geometry publish together. A draw is rejected
 * until that pair has completed its fixed-step writeback, so the renderer
 * never consumes a half-published World snapshot.
 */
export function derivedPhysicsFrameError(
  world: World,
): RendererOperationError<'frame-input-invalid'> | undefined {
  {
    if (!world.hasResource(PhysicsWorldResource)) return undefined;
    const physics = world.getResource(PhysicsWorldResource);
    if (
      physics?.getDerivedAdmission?.() !== undefined ||
      physics?.getDerivedRecoveryState?.() === 'rebuild-required'
    ) {
      return new RendererOperationError('frame-input-invalid', {
        operation: 'draw',
        cause: new RendererContractFailureError(
          'draw',
          'paired geometry admission must finish physics step and writeback in a healthy World before draw',
        ),
      });
    }
  }
  return undefined;
}

/** A host-side atomic-swap fault fences every later frame for that World. */
export function dynamicGeometryFrameError(
  world: World,
  faultForWorld: (world: World) => DynamicGeometryError | undefined,
): RendererOperationError<'frame-input-invalid'> | undefined {
  {
    const fault = faultForWorld(world);
    if (fault !== undefined) {
      return new RendererOperationError('frame-input-invalid', {
        operation: 'draw',
        cause: new RendererContractFailureError(
          'draw',
          `dynamic geometry admission faulted this World (${fault.code}); rebuild the paired World and Renderer`,
        ),
      });
    }
  }
  return undefined;
}
