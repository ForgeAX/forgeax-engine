import type { RenderError } from '../errors/render';
import { RenderTargetOperationFailedError, RenderTargetStateInvalidError } from '../errors/render';
import type { RenderResult } from '../render-contract';
import type { RenderTarget } from './contracts';

export interface RenderTargetReadbackReceipt {
  readonly frameId: number;
  readonly deviceGeneration: number;
}

export interface RenderTargetReadbackTicketInput {
  readonly frameId?: number;
  deviceGeneration: number;
  readonly mipLevel: number;
  readonly layer?: number;
  readonly width: number;
  readonly height: number;
  readonly bytesPerPixel: number;
}

export interface RenderTargetReadbackTicket {
  readonly target: RenderTarget;
  frameId: number | undefined;
  deviceGeneration: number;
  readonly mipLevel: number;
  readonly layer?: number;
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly byteLength: number;
  consumed: boolean;
}

export interface RenderTargetReadbackResult {
  readonly bytes: Uint8Array;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly mipLevel: number;
  readonly layer?: number;
}

function invalidTicket(
  ticket: RenderTargetReadbackTicket,
  reason: 'uninitialized' | 'generation-mismatch' | 'destroyed',
): RenderResult<never, RenderError> {
  return {
    ok: false,
    error: new RenderTargetStateInvalidError({
      operation: 'readback',
      reason,
      state: reason === 'destroyed' ? 'destroyed' : 'active',
      generation: ticket.deviceGeneration,
    }),
  };
}

export function bindRenderTargetReadbackTicket(
  ticket: RenderTargetReadbackTicket,
  receipt: RenderTargetReadbackReceipt,
): RenderResult<void, RenderError> {
  if (ticket.consumed) return invalidTicket(ticket, 'destroyed');
  if (ticket.frameId !== undefined) {
    return invalidTicket(ticket, 'generation-mismatch');
  }
  ticket.frameId = receipt.frameId;
  ticket.deviceGeneration = receipt.deviceGeneration;
  return { ok: true, value: undefined };
}

export function createRenderTargetReadbackTicket(
  target: RenderTarget,
  input: RenderTargetReadbackTicketInput,
): RenderResult<RenderTargetReadbackTicket, RenderError> {
  if (
    (input.frameId !== undefined && (!Number.isInteger(input.frameId) || input.frameId < 0)) ||
    !Number.isInteger(input.deviceGeneration) ||
    input.deviceGeneration < 0 ||
    !Number.isInteger(input.mipLevel) ||
    input.mipLevel < 0 ||
    !Number.isInteger(input.width) ||
    input.width < 1 ||
    !Number.isInteger(input.height) ||
    input.height < 1 ||
    !Number.isInteger(input.bytesPerPixel) ||
    input.bytesPerPixel < 1
  ) {
    return {
      ok: false,
      error: new RenderTargetOperationFailedError({
        operation: 'readback',
        stage: 'copy',
        generation: input.deviceGeneration,
        cause: new Error('readback dimensions and identity must be non-negative integers'),
        recovery: 'retry',
      }),
    };
  }
  const unalignedRowBytes = input.width * input.bytesPerPixel;
  const bytesPerRow = Math.ceil(unalignedRowBytes / 256) * 256;
  return {
    ok: true,
    value: {
      target,
      frameId: input.frameId,
      deviceGeneration: input.deviceGeneration,
      mipLevel: input.mipLevel,
      ...(input.layer === undefined ? {} : { layer: input.layer }),
      width: input.width,
      height: input.height,
      bytesPerRow,
      byteLength: bytesPerRow * input.height,
      consumed: false,
    },
  };
}

export function completeRenderTargetReadback(
  ticket: RenderTargetReadbackTicket,
  receipt: RenderTargetReadbackReceipt,
  bytes: Uint8Array,
): RenderResult<RenderTargetReadbackResult, RenderError> {
  if (ticket.consumed) return invalidTicket(ticket, 'destroyed');
  if (
    ticket.frameId === undefined ||
    receipt.frameId !== ticket.frameId ||
    receipt.deviceGeneration !== ticket.deviceGeneration
  ) {
    return invalidTicket(ticket, 'generation-mismatch');
  }
  if (bytes.byteLength !== ticket.byteLength) {
    return {
      ok: false,
      error: new RenderTargetOperationFailedError({
        operation: 'readback',
        stage: 'copy',
        generation: ticket.deviceGeneration,
        cause: new Error(`expected ${ticket.byteLength} bytes, received ${bytes.byteLength}`),
        recovery: 'retry',
      }),
    };
  }
  ticket.consumed = true;
  return {
    ok: true,
    value: {
      bytes,
      frameId: ticket.frameId,
      deviceGeneration: ticket.deviceGeneration,
      mipLevel: ticket.mipLevel,
      ...(ticket.layer === undefined ? {} : { layer: ticket.layer }),
    },
  };
}
