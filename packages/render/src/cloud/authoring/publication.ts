import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type CloudAuthoringError,
  type CloudAuthoringLocation,
  cloudAuthoringError,
} from '../errors';

export interface CloudPublicationLease<T> {
  readonly revision: string;
  readonly value: T;
  release(): void;
}

export interface CloudPublicationSource<T> {
  load(signal: AbortSignal): Promise<Result<CloudPublicationLease<T>, CloudAuthoringError>>;
}

/** A preparation candidate owns its lease until accepted by the current generation. */
export class CloudPublication<T> {
  private epoch = 0;
  private pending: AbortController | undefined;
  private active: CloudPublicationLease<T> | undefined;

  current(): T | undefined {
    return this.active?.value;
  }

  async prepare(
    source: CloudPublicationSource<T>,
    location: CloudAuthoringLocation,
  ): Promise<Result<T, CloudAuthoringError>> {
    this.pending?.abort();
    const signal = new AbortController();
    this.pending = signal;
    const epoch = ++this.epoch;
    const loaded = await source.load(signal.signal);
    if (this.epoch !== epoch || signal.signal.aborted) {
      if (loaded.ok) loaded.value.release();
      return err(
        cloudAuthoringError(
          'cloud-publication-stale',
          location,
          'revision',
          'candidate was superseded',
        ),
      );
    }
    this.pending = undefined;
    if (!loaded.ok) return loaded;
    if (this.active?.revision === loaded.value.revision) {
      loaded.value.release();
      return ok(this.active.value);
    }
    const previous = this.active;
    this.active = loaded.value;
    previous?.release();
    return ok(loaded.value.value);
  }

  dispose(): void {
    this.epoch++;
    this.pending?.abort();
    this.pending = undefined;
    const previous = this.active;
    this.active = undefined;
    previous?.release();
  }
}
