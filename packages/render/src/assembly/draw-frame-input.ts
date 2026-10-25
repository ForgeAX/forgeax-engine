import type { World } from '@forgeax/engine-ecs';
import { RendererContractFailureError, RendererOperationError } from '../errors/render';
import { motionBlurDrawOptions } from '../features/motion-blur/motion-blur-runtime';
import type { PublishedRenderFrameInput } from '../publication/contract';
import type { PreparedRenderPublication } from '../publication/receiver';
import { renderPublicationTiming } from '../publication/record';
import type { DrawOwnerOptions, RenderFrameInput } from '../render-contract';

/** The three draw entry shapes: a legacy World list, a lease frame, or a publication. */
export type DrawRequest = readonly World[] | RenderFrameInput | PublishedRenderFrameInput;

export function publicationDrawRequest(
  request: DrawRequest,
): PublishedRenderFrameInput | undefined {
  return !Array.isArray(request) && 'publication' in request
    ? (request as PublishedRenderFrameInput)
    : undefined;
}

export function frameDrawRequest(request: DrawRequest): RenderFrameInput | undefined {
  return !Array.isArray(request) && !('publication' in request)
    ? (request as RenderFrameInput)
    : undefined;
}

export function sceneFreeFrameInputError(): RendererOperationError<'frame-input-invalid'> {
  return new RendererOperationError('frame-input-invalid', {
    operation: 'draw',
    cause: new RendererContractFailureError(
      'draw',
      'a scene-free frame requires empty leases, null camera/environment and configured screen UI',
    ),
  });
}

export function unattachedFrameLeaseError(): RendererOperationError<'world-lease-invalid'> {
  return new RendererOperationError('world-lease-invalid', {
    operation: 'draw',
    cause: new RendererContractFailureError(
      'draw',
      'every RenderFrameInput lease must be attached to this Renderer',
    ),
  });
}

export function missingFrameLeaseOwnerError(
  cameraMissing: boolean,
): RendererOperationError<'frame-input-invalid'> {
  return new RendererOperationError('frame-input-invalid', {
    operation: 'draw',
    cause: new RendererContractFailureError(
      'draw',
      cameraMissing
        ? 'camera lease must be present in RenderFrameInput.leases'
        : 'environment lease must be present in RenderFrameInput.leases',
    ),
  });
}

/** Index of a camera/environment binding's lease; -1 when absent or unlisted. */
function leaseOwnerIndex<Lease>(
  leases: readonly Lease[],
  binding: { readonly lease: Lease } | null | undefined,
): number {
  return binding == null ? -1 : leases.indexOf(binding.lease);
}

/** Owner indices and per-frame options a lease frame selects. */
export function frameDrawOwnerOptions(frameRequest: RenderFrameInput): DrawOwnerOptions {
  return {
    cameraOwner: leaseOwnerIndex(frameRequest.leases, frameRequest.camera),
    resourceOwner: leaseOwnerIndex(frameRequest.leases, frameRequest.environment),
    ...(frameRequest.camera?.entityKey === undefined
      ? {}
      : { cameraEntityKey: frameRequest.camera.entityKey }),
    ...motionBlurDrawOptions(frameRequest),
    ...(frameRequest.profileFrame === undefined ? {} : { profileFrame: frameRequest.profileFrame }),
    ...(frameRequest.geometryObservation === true ? { geometryObservation: true as const } : {}),
    ...(frameRequest.geometryLane === undefined ? {} : { geometryLane: frameRequest.geometryLane }),
  };
}

/** A publication always draws its single receiver World with transported timing. */
export function publicationDrawOwnerOptions(request: PublishedRenderFrameInput): DrawOwnerOptions {
  return {
    cameraOwner: 0,
    resourceOwner: 0,
    ...renderPublicationTiming(request.publication),
    ...(request.geometryObservation === true
      ? {
          geometryObservation: true as const,
          ...(request.geometryObservationSourceWorldIdentity === undefined
            ? {}
            : {
                geometryObservationSourceWorldIdentity:
                  request.geometryObservationSourceWorldIdentity,
              }),
        }
      : {}),
    ...(request.geometryLane === undefined ? {} : { geometryLane: request.geometryLane }),
  };
}

/** Carry the realm-local source-feedback adapter onto the accepted publication. */
export function withFeatureSourceFeedback(
  publication: PreparedRenderPublication,
  request: PublishedRenderFrameInput,
): PreparedRenderPublication {
  return {
    ...publication,
    ...(request.onFeatureSourceSubmitted === undefined
      ? {}
      : { onFeatureSourceSubmitted: request.onFeatureSourceSubmitted }),
  };
}
