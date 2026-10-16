import type { Texture, TextureFormat } from '@forgeax/engine-rhi';
import { err, ok, RenderGraphError, type Result } from './errors.js';

export { RenderGraphError } from './errors.js';

const COPY_SRC = 0x01;

export interface ObservationSize {
  readonly width: number;
  readonly height: number;
}

/** Generic producer-owned metadata for one current-frame texture. */
export interface CurrentFrameObservationDescriptor {
  readonly texture: Texture;
  readonly format: TextureFormat;
  readonly size: ObservationSize;
  readonly usage: number;
  readonly frameId: number;
}

export interface CurrentFrameObservationLifetime {
  readonly frameId: number;
  readonly state: 'active' | 'retired';
}

/** The only resource information a downstream copy consumer receives. */
export interface CurrentFrameObservationSource {
  readonly texture: Texture;
  readonly descriptor: CurrentFrameObservationDescriptor;
  readonly lifetime: CurrentFrameObservationLifetime;
}

export interface CurrentFrameObservationLease {
  readonly descriptor: CurrentFrameObservationDescriptor;
  readonly lifetime: CurrentFrameObservationLifetime;
  readonly state: 'active' | 'retired';
  beginReadback(): Result<CurrentFrameObservationSource, RenderGraphError>;
  retire(): void;
}

function observationError(
  code:
    | 'observation-absent'
    | 'observation-invalid-format'
    | 'observation-invalid-size'
    | 'observation-missing-copy-src'
    | 'observation-stale',
  expected: string,
  hint: string,
): Result<never, RenderGraphError> {
  return err(new RenderGraphError({ code, expected, hint }));
}

/**
 * Validate and lease a producer's current-frame texture without naming any
 * semantic, pipeline, backend policy, or graph resource key.
 */
export function createCurrentFrameObservationLease(
  descriptor: CurrentFrameObservationDescriptor,
  currentFrameId: number,
): Result<CurrentFrameObservationLease, RenderGraphError> {
  if (descriptor.texture === undefined || descriptor.texture === null) {
    return observationError(
      'observation-absent',
      'a producer-owned texture handle',
      'provide the current frame color texture before requesting an observation',
    );
  }
  if (descriptor.format !== 'rgba16float') {
    return observationError(
      'observation-invalid-format',
      "current-frame observation format 'rgba16float'",
      'use the producer target format without reinterpretation',
    );
  }
  if (
    !Number.isInteger(descriptor.size.width) ||
    !Number.isInteger(descriptor.size.height) ||
    descriptor.size.width <= 0 ||
    descriptor.size.height <= 0
  ) {
    return observationError(
      'observation-invalid-size',
      'positive integer observation width and height',
      'capture a non-empty current-frame target',
    );
  }
  if ((descriptor.usage & COPY_SRC) === 0) {
    return observationError(
      'observation-missing-copy-src',
      'current-frame texture usage includes COPY_SRC',
      'add COPY_SRC to the producer target before requesting readback',
    );
  }
  if (descriptor.frameId !== currentFrameId) {
    return observationError(
      'observation-stale',
      `observation frame ${currentFrameId}`,
      `discard frame ${descriptor.frameId} and request the current producer target`,
    );
  }

  let state: 'active' | 'retired' = 'active';
  const lifetime: CurrentFrameObservationLifetime = {
    frameId: descriptor.frameId,
    get state() {
      return state;
    },
  };
  const lease: CurrentFrameObservationLease = {
    descriptor,
    lifetime,
    get state() {
      return state;
    },
    beginReadback() {
      if (state === 'retired') {
        return err(
          new RenderGraphError({
            code: 'observation-retired',
            expected: 'active current-frame observation lease',
            hint: 'submit the eager copy before the producer retires this frame',
          }),
        );
      }
      return ok({ texture: descriptor.texture, descriptor, lifetime });
    },
    retire() {
      state = 'retired';
    },
  };
  return ok(lease);
}
