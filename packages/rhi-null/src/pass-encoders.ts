// @forgeax/engine-rhi-null/src/pass-encoders - headless render / compute pass
// encoders and the render-bundle encoder whose recordings executeBundles replays.
//
// Both encoders are no-ops that thread state changes through nothing real; the
// only side effects are command-stream bookkeeping the M3 unit tests read back:
//   - draw / drawIndexed / drawIndirect / drawIndexedIndirect bump a draw
//     counter (AC-06);
//   - dispatchWorkgroups bumps a dispatch counter;
//   - setVertexBuffer / setBindGroup validate handle ownership against the
//     issuing device's ledger (AC-09 handle-chain consistency) and record the
//     outcome so an assertion can read the most recent validation result
//     without the call site throwing (the spec method form is void).
//
// Counters + last-validation live on the encoder instance (public readonly) so
// a test holding the pass encoder reads them directly; the per-device ledger
// (Bookkeeper) supplies cross-device validation.
//
// Related: requirements AC-04 (pass sequence) + AC-06 (draw count + binding
// assembly) + AC-09 (handle-chain consistency); research Finding A1 rows 6/7;
// plan-strategy §3.1 (pass encoder bookkeeping design) + §2 D-1.

import type {
  BindGroup,
  Buffer,
  ComputePipeline,
  RenderBundle,
  RenderBundleEncoderDescriptor,
  RenderPipeline,
  Result,
  RhiComputePassEncoder,
  RhiError as RhiErrorType,
  RhiRenderBundleEncoder,
  RhiRenderCommands,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { type Bookkeeper, isHandleDestroyed } from './bookkeeping';

const bundles = new WeakMap<
  RenderBundle,
  {
    readonly draws: number;
    readonly bindGroups: number;
    readonly resources: readonly object[];
  }
>();

export function createRenderBundleEncoder(
  bookkeeper: Bookkeeper,
  _desc: RenderBundleEncoderDescriptor,
): RhiRenderBundleEncoder {
  const pass = new RhiNullRenderPassEncoder(bookkeeper, null, 'bundle');
  const resources: object[] = [];
  let finished = false;
  const capture =
    (method: keyof RhiRenderCommands, resourceIndex?: number) =>
    (...args: unknown[]) => {
      if (finished)
        throw new RhiError({
          code: 'command-encoder-finished',
          expected: 'an unfinished bundle encoder',
          hint: 'create a new bundle encoder',
        });
      if (resourceIndex !== undefined) resources.push(args[resourceIndex] as object);
      Reflect.apply(pass[method], pass, args);
    };
  return {
    setPipeline: capture('setPipeline', 0),
    setVertexBuffer: capture('setVertexBuffer', 1),
    setIndexBuffer: capture('setIndexBuffer', 0),
    setBindGroup: capture('setBindGroup', 1),
    draw: capture('draw'),
    drawIndexed: capture('drawIndexed'),
    drawIndirect: capture('drawIndirect', 0),
    drawIndexedIndirect: capture('drawIndexedIndirect', 0),
    pushDebugGroup: capture('pushDebugGroup'),
    popDebugGroup: capture('popDebugGroup'),
    insertDebugMarker: capture('insertDebugMarker'),
    finish() {
      if (finished)
        return err(
          new RhiError({
            code: 'command-encoder-finished',
            expected: 'an unfinished bundle encoder',
            hint: 'create a new bundle encoder',
          }),
        );
      finished = true;
      for (const resource of resources) {
        const valid = bookkeeper.validateOwnership(resource);
        if (!valid.ok) return valid;
      }
      const bundle = bookkeeper.register('RenderBundle') as unknown as RenderBundle;
      bundles.set(bundle, { draws: pass.drawCount, bindGroups: pass.bindGroupCount, resources });
      return ok(bundle);
    },
  };
}

/** Shared counter interface that pass encoders bump so the device can aggregate
 *  per-frame stats for M3 unit-test readback. */
export interface PassCounter {
  recordDraw(): void;
  recordDispatch(): void;
  recordBindGroup(): void;
  recordPassName(name: string): void;
}

/**
 * Headless render pass encoder. Records draw counts + the most recent handle
 * validation outcome; all state-setting methods are no-ops.
 */
export class RhiNullRenderPassEncoder implements RhiRenderPassEncoder {
  /** Number of draw* calls issued on this pass (AC-06 readback). */
  drawCount = 0;
  bindGroupCount = 0;
  /** Most recent setVertexBuffer / setBindGroup ownership validation; ok unless
   *  a foreign handle was passed (AC-09 readback). */
  lastValidation: Result<unknown, RhiErrorType> = ok(undefined);

  private readonly bookkeeper: Bookkeeper;
  private readonly counter: PassCounter | null;
  readonly passName: string;

  constructor(bookkeeper: Bookkeeper, counter: PassCounter | null, passName: string) {
    this.bookkeeper = bookkeeper;
    this.counter = counter;
    this.passName = passName;
  }

  setPipeline(_pipeline: RenderPipeline): void {}

  setVertexBuffer(
    _slot: number,
    buffer: Buffer,
    _offset?: number | undefined,
    _size?: number | undefined,
  ): void {
    this.lastValidation = this.bookkeeper.validateOwnership(buffer);
  }

  setIndexBuffer(
    _buffer: Buffer,
    _format: 'uint16' | 'uint32',
    _offset?: number | undefined,
    _size?: number | undefined,
  ): void {}

  setBindGroup(
    _index: number,
    bindGroup: BindGroup,
    _dynamicOffsetsData?: readonly number[] | Uint32Array | undefined,
    _dynamicOffsetsDataStart?: number | undefined,
    _dynamicOffsetsDataLength?: number | undefined,
  ): void {
    this.bindGroupCount++;
    this.counter?.recordBindGroup();
    this.lastValidation = this.bookkeeper.validateOwnership(bindGroup);
  }

  draw(
    _vertexCount: number,
    _instanceCount?: number | undefined,
    _firstVertex?: number | undefined,
    _firstInstance?: number | undefined,
  ): void {
    this.drawCount++;
    this.counter?.recordDraw();
  }

  drawIndexed(
    _indexCount: number,
    _instanceCount?: number | undefined,
    _firstIndex?: number | undefined,
    _baseVertex?: number | undefined,
    _firstInstance?: number | undefined,
  ): void {
    this.drawCount++;
    this.counter?.recordDraw();
  }

  end(): void {
    this.counter?.recordPassName(this.passName);
  }

  setViewport(
    _x: number,
    _y: number,
    _w: number,
    _h: number,
    _minDepth: number,
    _maxDepth: number,
  ): void {}

  setScissorRect(_x: number, _y: number, _w: number, _h: number): void {}

  setBlendConstant(_color: GPUColor): void {}

  setStencilReference(_reference: number): void {}

  drawIndirect(_indirectBuffer: Buffer, _indirectOffset: number): void {
    this.drawCount++;
    this.counter?.recordDraw();
  }

  drawIndexedIndirect(_indirectBuffer: Buffer, _indirectOffset: number): void {
    this.drawCount++;
    this.counter?.recordDraw();
  }

  pushDebugGroup(_groupLabel: string): void {}

  popDebugGroup(): void {}

  insertDebugMarker(_markerLabel: string): void {}

  executeBundles(handles: Iterable<RenderBundle>): Result<void, RhiErrorType> {
    let drawCount = 0;
    let bindGroupCount = 0;
    for (const handle of handles) {
      const valid = this.bookkeeper.validateOwnership(handle);
      if (!valid.ok) return valid;
      const bundle = bundles.get(handle);
      if (bundle === undefined)
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'a render bundle from this device',
            hint: 'use createRenderBundleEncoder().finish()',
          }),
        );
      drawCount += bundle.draws;
      bindGroupCount += bundle.bindGroups;
      for (const resource of bundle.resources) {
        const validResource = this.bookkeeper.validateOwnership(resource);
        if (!validResource.ok) return validResource;
        const live = isHandleDestroyed(resource);
        if (!live.ok) return live;
      }
    }
    for (let i = 0; i < drawCount; i++) {
      this.drawCount++;
      this.counter?.recordDraw();
    }
    for (let i = 0; i < bindGroupCount; i++) {
      this.bindGroupCount++;
      this.counter?.recordBindGroup();
    }
    return ok(undefined);
  }

  beginOcclusionQuery(_queryIndex: number): Result<void, RhiErrorType> {
    return ok(undefined);
  }

  endOcclusionQuery(): Result<void, RhiErrorType> {
    return ok(undefined);
  }
}

/**
 * Headless compute pass encoder. Records dispatch counts; all state-setting
 * methods are no-ops.
 */
export class RhiNullComputePassEncoder implements RhiComputePassEncoder {
  /** Number of dispatchWorkgroups calls issued on this pass (readback). */
  dispatchCount = 0;
  /** Most recent setBindGroup ownership validation (AC-09 readback). */
  lastValidation: Result<unknown, RhiErrorType> = ok(undefined);

  private readonly bookkeeper: Bookkeeper;
  private readonly counter: PassCounter | null;
  readonly passName: string;

  constructor(bookkeeper: Bookkeeper, counter: PassCounter | null, passName: string) {
    this.bookkeeper = bookkeeper;
    this.counter = counter;
    this.passName = passName;
  }

  setPipeline(_pipeline: ComputePipeline): void {}

  setBindGroup(
    _index: number,
    bindGroup: BindGroup,
    _dynamicOffsets?: readonly number[] | undefined,
  ): void {
    this.lastValidation = this.bookkeeper.validateOwnership(bindGroup);
  }

  dispatchWorkgroups(_x: number, _y?: number | undefined, _z?: number | undefined): void {
    this.dispatchCount++;
    this.counter?.recordDispatch();
  }

  dispatchWorkgroupsIndirect(indirectBuffer: Buffer, _indirectOffset: number): void {
    this.lastValidation = this.bookkeeper.validateOwnership(indirectBuffer);
    this.dispatchCount++;
    this.counter?.recordDispatch();
  }

  end(): void {
    this.counter?.recordPassName(this.passName);
  }
}
