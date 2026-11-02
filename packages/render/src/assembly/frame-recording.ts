import type { RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { RendererOperationCause } from '../errors/render';
export interface RecordedView {
  /** A preparation barrier completes GPU work without publishing a scene picture. */
  readonly presentation?: import('../render-contract').FramePresentation;
  readonly beforeSubmit?: ((device: RhiDevice) => RhiError | undefined) | undefined;
  readonly isCurrent?: () => boolean;
  readonly rejectionCause?: () => RendererOperationCause | undefined;
  /** Physical submission, before any publication callback or generation rejection. */
  readonly onSubmittedWork?: (completed: Promise<void>) => void;
  readonly reportError: (error: RhiError) => void;
}

export type FramePreparationCheckpoint = {
  readonly kind: 'features-prepared' | 'recording-checkpoint';
};

export type FramePreparation<T = boolean> = Generator<FramePreparationCheckpoint, T, void>;

export function drainFramePreparation<T>(operation: FramePreparation<T>): T {
  let next = operation.next();
  while (!next.done) next = operation.next();
  return next.value;
}
