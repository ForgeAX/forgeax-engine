// @forgeax/engine-rhi-null/src/command-encoder - headless command encoder.
//
// RhiNullCommandEncoder is a no-op recorder: begin*Pass returns a fresh
// pass-encoder bound to the same per-device ledger. Render attachments and
// copy resources become immutable CommandBuffer references at finish, so
// submit validates the real dependency closure before canvas retirement.
//
// Each beginRenderPass / beginComputePass reads the `label` from the descriptor
// and threads it as the pass name to the per-device counters so M3 unit tests
// (w17 AC-04) can assert per-frame pass scheduling order.
//
// Related: requirements AC-04 (pass sequence) + AC-06 (draw count via pass
// encoders); research Finding A1 row 5; plan-strategy §3.1.

import type {
  BlasBuildEntry,
  Buffer,
  BufferCopyDestination,
  CommandBuffer,
  ComputePassDescriptor,
  QuerySet,
  RenderPassDescriptor,
  Result,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiError as RhiErrorType,
  RhiRenderPassEncoder,
  TextureCopySource,
  TlasBuildEntry,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import type { Bookkeeper } from './bookkeeping';
import type { RhiNullDevice } from './device';
import {
  type PassCounter,
  RhiNullComputePassEncoder,
  RhiNullRenderPassEncoder,
} from './pass-encoders';

/**
 * Internal counter that writes per-frame stats back to the owning device.
 */
class DeviceCounter implements PassCounter {
  constructor(private readonly device: RhiNullDevice) {}

  recordDraw(): void {
    this.device.totalDrawCount++;
  }

  recordDispatch(): void {
    this.device.totalDispatchCount++;
  }

  recordBindGroup(): void {
    this.device.totalBindGroupCount++;
  }

  recordPassName(name: string): void {
    this.device.framePassNames.push(name);
  }
}

/**
 * Read the `label` field from a GPURenderPassDescriptor (or undefined if not
 * set). The engine sets `label` on the render pass descriptor; the graph's
 * compile path doesn't always thread a per-pass label, so we fall back to the
 * RenderPassDescriptor's generic label (or '<unnamed>').
 */
function readPassLabel(desc: { readonly label?: string | undefined } | undefined): string {
  if (desc && typeof desc.label === 'string' && desc.label.length > 0) {
    return desc.label as string;
  }
  return '<unnamed>';
}

/**
 * Headless command encoder. begin*Pass returns a no-op pass encoder bound to
 * the issuing device's ledger; recording methods are no-ops; finish mints a
 * CommandBuffer brand.
 */
export class RhiNullCommandEncoder implements RhiCommandEncoder {
  private readonly bookkeeper: Bookkeeper;
  private readonly counter: PassCounter;
  private readonly device: RhiNullDevice;
  private finished = false;
  private readonly references = new Set<unknown>();
  private encodingError: RhiErrorType | undefined;
  private openPasses = 0;

  constructor(bookkeeper: Bookkeeper, device: RhiNullDevice) {
    this.bookkeeper = bookkeeper;
    this.device = device;
    this.counter = new DeviceCounter(device);
  }

  buildAccelerationStructures(
    blas: readonly BlasBuildEntry[],
    tlas: readonly TlasBuildEntry[],
  ): Result<void, RhiErrorType> {
    return this.device._accelerationStructures.build(blas, tlas);
  }

  beginRenderPass(desc: RenderPassDescriptor): RhiRenderPassEncoder {
    this.assertUnfinished();
    for (const attachment of desc.colorAttachments) {
      if (attachment == null) continue;
      this.reference(attachment.view, 'TextureView');
      if (attachment.resolveTarget !== undefined)
        this.reference(attachment.resolveTarget, 'TextureView');
    }
    if (desc.depthStencilAttachment !== undefined)
      this.reference(desc.depthStencilAttachment.view, 'TextureView');
    const label = readPassLabel(desc);
    return this.trackPass(new RhiNullRenderPassEncoder(this.bookkeeper, this.counter, label));
  }

  beginComputePass(desc?: ComputePassDescriptor | undefined): RhiComputePassEncoder {
    this.assertUnfinished();
    const label = readPassLabel(desc);
    return this.trackPass(new RhiNullComputePassEncoder(this.bookkeeper, this.counter, label));
  }

  encodeEmptyComputePass(desc: ComputePassDescriptor): void {
    this.assertUnfinished();
    this.counter.recordPassName(readPassLabel(desc));
  }

  copyBufferToBuffer(
    source: Buffer,
    sourceOffsetOrDestination: number | Buffer,
    destinationOrSize?: Buffer | number | undefined,
    _destinationOffset?: number | undefined,
    _size?: number | undefined,
  ): void {
    this.reference(source, 'Buffer');
    this.reference(
      typeof sourceOffsetOrDestination === 'number' ? destinationOrSize : sourceOffsetOrDestination,
      'Buffer',
    );
  }

  copyBufferToTexture(
    source: GPUTexelCopyBufferInfo,
    destination: GPUTexelCopyTextureInfo,
    _copySize: GPUExtent3DStrict,
  ): void {
    this.reference(source.buffer, 'Buffer');
    this.reference(destination.texture, 'Texture');
  }

  copyTextureToBuffer(
    source: GPUTexelCopyTextureInfo | TextureCopySource,
    destination: GPUTexelCopyBufferInfo | BufferCopyDestination,
    _copySize: GPUExtent3DStrict,
  ): void {
    this.reference(source.texture, 'Texture');
    this.reference(destination.buffer, 'Buffer');
  }

  copyTextureToTexture(
    source: GPUTexelCopyTextureInfo,
    destination: GPUTexelCopyTextureInfo,
    _copySize: GPUExtent3DStrict,
  ): void {
    this.reference(source.texture, 'Texture');
    this.reference(destination.texture, 'Texture');
  }

  clearBuffer(_buffer: Buffer, _offset?: number | undefined, _size?: number | undefined): void {}

  resolveQuerySet(
    _querySet: QuerySet,
    _firstQuery: number,
    _queryCount: number,
    _destination: Buffer,
    _destinationOffset: number,
  ): Result<void, RhiErrorType> {
    return ok(undefined);
  }

  pushDebugGroup(_groupLabel: string): void {}

  popDebugGroup(): void {}

  insertDebugMarker(_markerLabel: string): void {}

  finish(): Result<CommandBuffer, RhiErrorType> {
    if (this.finished)
      return err(
        new RhiError({
          code: 'command-encoder-finished',
          expected: 'an unfinished command encoder',
          hint: 'create a new command encoder via device.createCommandEncoder() for each submission',
        }),
      );
    if (this.encodingError !== undefined) return err(this.encodingError);
    if (this.openPasses !== 0)
      return err(
        new RhiError({
          code: 'render-pass-not-ended',
          expected: 'all command encoder passes have ended',
          hint: 'end the active render or compute pass before calling finish()',
        }),
      );
    const live = this.bookkeeper.dependencies([...this.references]);
    if (!live.ok) return live;
    this.finished = true;
    return ok(
      this.bookkeeper.register('CommandBuffer', [...this.references]) as unknown as CommandBuffer,
    );
  }

  private assertUnfinished(): void {
    if (this.finished)
      throw new RhiError({
        code: 'command-encoder-finished',
        expected: 'an unfinished command encoder',
        hint: 'create a new command encoder before recording more commands',
      });
  }

  private reference(handle: unknown, kind: string): void {
    this.assertUnfinished();
    const valid = this.bookkeeper.validateLive(handle, kind);
    if (!valid.ok) {
      this.encodingError ??= valid.error;
      throw valid.error;
    }
    this.references.add(handle);
  }

  private trackPass<T extends { end(): void }>(pass: T): T {
    this.openPasses++;
    const end = pass.end.bind(pass);
    let ended = false;
    pass.end = () => {
      if (ended) return;
      ended = true;
      this.openPasses--;
      end();
    };
    return pass;
  }
}
