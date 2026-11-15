import type { ProfileFrameToken } from '@forgeax/engine-profiler';
import { RendererContractFailureError, RendererOperationError } from '../errors/render';
import { motionBlurDrawOptions } from '../features/motion-blur/motion-blur-runtime';
import type { PublishedRenderFrameInput } from '../publication/contract';
import type { PreparedRenderPublication } from '../publication/receiver';
import { renderPublicationTiming } from '../publication/record';
import type { DrawOptions, RenderFrameInput } from '../render-contract';

type MutableFrameDrawOptions = Omit<
  DrawOptions,
  'profileFrame' | 'geometryObservation' | 'geometryLane'
> & {
  profileFrame?: ProfileFrameToken;
  geometryObservation?: true;
  geometryLane?: NonNullable<DrawOptions['geometryLane']>;
};

/** A source lease frame or an accepted publication. */
export type DrawRequest = RenderFrameInput | PublishedRenderFrameInput;

export function publicationDrawRequest(
  request: DrawRequest,
): PublishedRenderFrameInput | undefined {
  return 'publication' in request ? (request as PublishedRenderFrameInput) : undefined;
}

export function frameDrawRequest(request: DrawRequest): RenderFrameInput | undefined {
  return !('publication' in request) ? (request as RenderFrameInput) : undefined;
}

export function sceneFreeFrameInputError(): RendererOperationError<'frame-input-invalid'> {
  return new RendererOperationError('frame-input-invalid', {
    operation: 'draw',
    cause: new RendererContractFailureError(
      'draw',
      'a UI-only frame requires a null source, no camera selection and configured screen UI',
    ),
  });
}

export function unattachedFrameLeaseError(): RendererOperationError<'world-lease-invalid'> {
  return new RendererOperationError('world-lease-invalid', {
    operation: 'draw',
    cause: new RendererContractFailureError(
      'draw',
      'the source lease must be attached to this Renderer',
    ),
  });
}

/** Per-frame options selected by a source lease. */
export function frameDrawOptions(frameRequest: RenderFrameInput): DrawOptions {
  const options: MutableFrameDrawOptions = {
    ...(frameRequest.camera?.entityKey === undefined
      ? {}
      : { cameraEntityKey: frameRequest.camera.entityKey }),
    ...motionBlurDrawOptions(frameRequest),
  };
  // Read and detach the borrowed token at its original spread position. Keeping
  // this in the same result object avoids probing the request a second time or
  // allocating an intermediate options wrapper around it.
  const token = frameRequest.profileFrame;
  if (token !== undefined) options.profileFrame = detachProfileFrameToken(token);
  if (frameRequest.geometryObservation === true) options.geometryObservation = true;
  if (frameRequest.geometryLane !== undefined) options.geometryLane = frameRequest.geometryLane;
  return options;
}

/** Copy a borrowed profiler token without copying or probing its containing options object. */
export function detachProfileFrameToken(token: ProfileFrameToken): ProfileFrameToken {
  const captureId = token.captureId;
  const frameId = token.frameId;
  return Object.freeze({ captureId, frameId });
}

/** Read and detach only the token; preserve the borrowed options object and its receiver. */
export function captureDrawOwnerProfileFrame(options: DrawOptions): ProfileFrameToken | undefined {
  const token = options.profileFrame;
  return token === undefined ? undefined : detachProfileFrameToken(token);
}

/** A publication always draws its single receiver World with transported timing. */
export function publicationDrawOptions(request: PublishedRenderFrameInput): DrawOptions {
  return {
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
