// @forgeax/engine-rhi-null/src/queue - headless command queue.
//
// Uploads are structural no-ops. Submit validates actual finished command
// membership before notifying canvas resources of their completion boundary.
// No GPU work or browser compositor behavior is simulated.
//
// Related: requirements AC-12 (submit ok + onSubmittedWorkDone resolves);
// research Finding A1 row 4.

import type {
  Buffer,
  CommandBuffer,
  ExternalImageTextureDestination,
  Result,
  RhiError as RhiErrorType,
  RhiQueue,
  TexelCopyTextureInfo,
} from '@forgeax/engine-rhi';
import { createQueueCompletionHold, RhiError } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import type { Bookkeeper } from './bookkeeping';

/** Headless no-op queue. */
export class RhiNullQueue implements RhiQueue {
  private bookkeeper: Bookkeeper | undefined;
  private readonly completions = createQueueCompletionHold();

  /** Device construction binds this queue once to its actual ledger. */
  bind(bookkeeper: Bookkeeper): void {
    if (this.bookkeeper !== undefined)
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'an unbound Null queue',
        hint: 'create a new queue for each device; queue ownership cannot be replaced',
      });
    this.bookkeeper = bookkeeper;
  }
  writeBuffer(
    _buffer: Buffer,
    _bufferOffset: number,
    _data: ArrayBufferView | ArrayBuffer,
    _dataOffset?: number | undefined,
    _size?: number | undefined,
  ): Result<void, RhiErrorType> {
    return ok(undefined);
  }

  writeTexture(
    _destination: TexelCopyTextureInfo,
    _data: ArrayBufferView | ArrayBuffer,
    _dataLayout: Pick<GPUTexelCopyBufferLayout, 'offset' | 'bytesPerRow' | 'rowsPerImage'>,
    _size: GPUExtent3DStrict,
  ): Result<void, RhiErrorType> {
    return ok(undefined);
  }

  copyExternalImageToTexture(
    _source: Pick<GPUCopyExternalImageSourceInfo, 'source' | 'origin' | 'flipY'>,
    _destination: ExternalImageTextureDestination,
    _copySize: GPUExtent3DStrict,
  ): Result<void, RhiErrorType> {
    return ok(undefined);
  }

  submit(commandBuffers: readonly CommandBuffer[]): Result<void, RhiErrorType> {
    const bookkeeper = this.bookkeeper;
    if (bookkeeper === undefined)
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'a queue bound to its Null device',
          hint: 'request a device through RhiNullAdapter before submitting commands',
        }),
      );
    const unique = new Set(commandBuffers);
    if (unique.size !== commandBuffers.length)
      return err(
        new RhiError({
          code: 'queue-submit-failed',
          expected: 'each command buffer appears once in a submission',
          hint: 'remove duplicate command buffers from the submitted array',
        }),
      );
    for (const buffer of commandBuffers) {
      const valid = bookkeeper.validateLive(buffer, 'CommandBuffer');
      if (!valid.ok) return valid;
    }
    const dependencies = bookkeeper.dependencies(commandBuffers);
    if (!dependencies.ok) return dependencies;
    const observers = dependencies.value.filter((member) => member.onSubmitted !== undefined);
    const completion = observers.length === 0 ? undefined : this.onSubmittedWorkDone();
    for (const buffer of commandBuffers) bookkeeper.destroy(buffer).unwrap();
    if (completion !== undefined) for (const member of observers) member.onSubmitted?.(completion);
    return ok(undefined);
  }

  // forgeax-async-whitelist: dom-native — spec `GPUQueue.onSubmittedWorkDone`
  // has no hardware work in this backend, so it resolves immediately.
  onSubmittedWorkDone(): Promise<undefined> {
    return this.completions.deliver(Promise.resolve(undefined));
  }

  holdCompletions(): () => void {
    return this.completions.hold();
  }

  // forgeax-async-whitelist: dom-native — immediate completion that ignores holds.
  onSubmittedWorkDoneUnheld(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}
